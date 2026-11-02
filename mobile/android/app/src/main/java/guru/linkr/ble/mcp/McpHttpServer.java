package guru.linkr.ble.mcp;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Small authenticated HTTP server that fronts the app's MCP endpoint.
 *
 * <p>The class deliberately contains no Android imports so the transport can be
 * exercised on a host JVM. All protocol logic lives in JavaScript; this server
 * only parses an HTTP request, enforces the security envelope (origin, bearer
 * token, size limits, one whole-request deadline) and hands authenticated
 * {@code POST /mcp} and {@code POST /a2a} bodies to a {@link Handler}. It also
 * forwards the public {@code GET /.well-known/agent-card.json} discovery
 * document without a token. The handler answers with a {@link Response} which
 * is written back verbatim.
 *
 * <p>A single unauthenticated peer must not be able to occupy a worker: the
 * request line, headers and body share one wall-clock {@link #REQUEST_DEADLINE_MS}
 * budget, and every accepted socket is tracked so {@link #stop()} can close
 * sockets that are blocked in a read.
 */
public final class McpHttpServer {

    /** Request line plus headers may not exceed this many bytes. */
    public static final int MAX_HEADER_BYTES = 16 * 1024;

    /** Content-Length is rejected above this size (1 MiB). */
    public static final int MAX_BODY_BYTES = 1024 * 1024;

    /** Per-read socket timeout for the request line, headers and body. */
    public static final int READ_TIMEOUT_MS = 10_000;

    /**
     * Wall-clock budget from acceptance, including queue wait, request line,
     * headers and body. A peer that
     * trickles one byte every few seconds still cannot hold a worker past this.
     */
    public static final int REQUEST_DEADLINE_MS = 20_000;

    /** Maximum number of requests parsed concurrently. */
    public static final int MAX_CONCURRENT_REQUESTS = 8;

    /** Answer used when the WebView side cannot serve the request. */
    public static final String NOT_READY_BODY =
            "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32000,\"message\":\"Linkr Bee app is not ready\"}}";

    /** Authenticated JSON-RPC endpoint for A2A; {@code /a2a/} is an alias. */
    private static final String A2A_PATH = "/a2a";

    /** Public A2A discovery document, served without a bearer token. */
    private static final String AGENT_CARD_PATH = "/.well-known/agent-card.json";

    private static final String STATUS_BODY = "{\"name\":\"linkr-bee-mcp\",\"version\":\"0.1.0\","
            + "\"mcp\":\"/mcp\",\"a2a\":\"/a2a\",\"agentCard\":\"/.well-known/agent-card.json\"}";
    private static final String BAD_REQUEST_BODY = "{\"error\":\"bad request\"}";
    private static final String UNAUTHORIZED_BODY = "{\"error\":\"unauthorized\"}";
    private static final String FORBIDDEN_BODY = "{\"error\":\"origin not allowed\"}";
    private static final String NOT_FOUND_BODY = "{\"error\":\"not found\"}";
    private static final String METHOD_NOT_ALLOWED_BODY = "{\"error\":\"method not allowed\"}";
    private static final String LENGTH_REQUIRED_BODY = "{\"error\":\"content length required\"}";
    private static final String TOO_LARGE_BODY = "{\"error\":\"request body too large\"}";
    private static final String EXPECTATION_FAILED_BODY = "{\"error\":\"expectation failed\"}";
    private static final String REQUEST_TIMEOUT_BODY = "{\"error\":\"request deadline exceeded\"}";

    private static final int MAX_QUEUED_REQUESTS = 64;
    private static final int ACCEPT_BACKOFF_MS = 50;

    /** Authenticated request, as seen by the JS sink. */
    public static final class Request {

        public final String method;
        public final String path;
        public final String remote;
        public final String userAgent;
        public final String body;

        public Request(String method, String path, String remote, String userAgent, String body) {
            this.method = method;
            this.path = path;
            this.remote = remote;
            this.userAgent = userAgent;
            this.body = body;
        }
    }

    /** Response produced by the JS sink. */
    public static final class Response {

        public final int status;
        public final String body;

        public Response(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    /**
     * Bridge to the WebView. Authenticated {@code POST /mcp} and {@code POST /a2a}
     * bodies reach it, plus the public agent-card {@code GET}.
     */
    public interface Handler {
        CompletableFuture<Response> handle(Request request);
    }

    private final Handler handler;
    private final boolean bindLan;
    private final int requestDeadlineMs;
    private final Set<CompletableFuture<Response>> inFlight = ConcurrentHashMap.newKeySet();
    /** Every accepted socket, closed when the connection finishes. */
    private final Set<Socket> clients = ConcurrentHashMap.newKeySet();
    /**
     * Accepted sockets whose worker may still be blocked in a read: the request
     * line, the headers or the body. Only these are force-closed by {@link #stop()};
     * sockets already waiting for the WebView answer must stay open long enough
     * to receive the 503 that stop delivers.
     */
    private final Set<Socket> readingClients = ConcurrentHashMap.newKeySet();

    private volatile String token;
    private volatile ServerSocket serverSocket;
    private volatile int port = -1;
    private volatile boolean running;
    private volatile ThreadPoolExecutor executor;

    public McpHttpServer(Handler handler, String token, boolean bindLan) {
        this(handler, token, bindLan, REQUEST_DEADLINE_MS);
    }

    /**
     * @param requestDeadlineMs whole-request budget; exposed so tests can use a
     *                          short deadline instead of sleeping 20 s.
     */
    public McpHttpServer(Handler handler, String token, boolean bindLan, int requestDeadlineMs) {
        this.handler = handler;
        this.token = token;
        this.bindLan = bindLan;
        this.requestDeadlineMs = requestDeadlineMs > 0 ? requestDeadlineMs : REQUEST_DEADLINE_MS;
    }

    /** Rotates the bearer token without restarting the server. */
    public void setToken(String token) {
        this.token = token;
    }

    /**
     * Binds and starts accepting. Pass {@code 0} for an ephemeral port (tests).
     *
     * @return the port actually bound
     */
    public synchronized int start(int requestedPort) throws IOException {
        if (requestedPort < 0 || requestedPort > 65535) {
            throw new IllegalArgumentException("Port must be between 0 and 65535");
        }
        if (running) {
            return port;
        }
        ServerSocket socket = new ServerSocket();
        socket.setReuseAddress(true);
        InetAddress address = bindLan ? InetAddress.getByName("0.0.0.0") : InetAddress.getLoopbackAddress();
        try {
            socket.bind(new InetSocketAddress(address, requestedPort), 50);
        } catch (IOException error) {
            /* A failed bind must not leak the descriptor: a retry loop on a busy
             * port would otherwise run the app out of file descriptors. */
            try {
                socket.close();
            } catch (IOException ignored) {
                // Nothing was bound; the original bind error is what matters.
            }
            throw error;
        }
        serverSocket = socket;
        port = socket.getLocalPort();

        AtomicInteger workerIndex = new AtomicInteger();
        ThreadFactory threadFactory = runnable -> {
            Thread thread = new Thread(runnable, "linkr-mcp-worker-" + workerIndex.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
        executor = new ThreadPoolExecutor(
                MAX_CONCURRENT_REQUESTS,
                MAX_CONCURRENT_REQUESTS,
                30L,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(MAX_QUEUED_REQUESTS),
                threadFactory,
                new ThreadPoolExecutor.AbortPolicy());
        running = true;

        Thread acceptThread = new Thread(() -> acceptLoop(socket), "linkr-mcp-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        return port;
    }

    /**
     * Stops accepting, answers pending requests with 503, closes the listening
     * socket and force-closes every connection still blocked in a read. Idempotent.
     */
    public synchronized void stop() {
        if (!running && serverSocket == null) {
            return;
        }
        running = false;
        for (CompletableFuture<Response> delivery : inFlight) {
            delivery.complete(new Response(503, NOT_READY_BODY));
        }
        inFlight.clear();
        ServerSocket socket = serverSocket;
        serverSocket = null;
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
                // The listener is being torn down; there is nothing to report.
            }
        }
        /* Sockets blocked in a read would otherwise keep their worker (and file
         * descriptor) forever: a slowloris client could pin all eight workers
         * across a stop/start cycle. Closing them unblocks the read; the worker
         * then closes the socket in its finally block. */
        List<Socket> blockedReaders = new ArrayList<>(readingClients);
        readingClients.clear();
        for (Socket blocked : blockedReaders) {
            discard(blocked);
            closeQuietly(blocked);
        }
        ThreadPoolExecutor pool = executor;
        executor = null;
        if (pool != null) {
            /* Queued tasks never reach handleConnection's finally block; their
             * sockets are in readingClients and were closed above. */
            pool.shutdownNow();
        }
    }

    public boolean isRunning() {
        return running;
    }

    /** The bound port, or -1 before {@link #start(int)}. */
    public int getPort() {
        return port;
    }

    private void acceptLoop(ServerSocket socket) {
        while (running && serverSocket == socket) {
            Socket client;
            try {
                client = socket.accept();
            } catch (IOException error) {
                if (!running || serverSocket != socket) {
                    return;
                }
                /* A transient accept failure (file-descriptor pressure, a
                 * connection reset before accept) must not silently turn the
                 * server into a dead listener that still reports running. */
                try {
                    Thread.sleep(ACCEPT_BACKOFF_MS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
                continue;
            }
            if (!running || serverSocket != socket) {
                closeQuietly(client);
                return;
            }
            long requestDeadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(requestDeadlineMs);
            clients.add(client);
            readingClients.add(client);
            try {
                client.setSoTimeout(READ_TIMEOUT_MS);
                ThreadPoolExecutor pool = executor;
                if (pool == null) {
                    discard(client);
                    closeQuietly(client);
                    return;
                }
                pool.execute(() -> handleConnection(client, requestDeadline));
                if (!running) {
                    /* stop() may have drained the queue between execute() and the
                     * worker starting: that task would never run and its socket
                     * would leak. Close it here instead. */
                    discard(client);
                    closeQuietly(client);
                }
            } catch (RejectedExecutionException rejected) {
                discard(client);
                try {
                    writeResponse(client, new Response(503, NOT_READY_BODY), null, false);
                } catch (IOException ignored) {
                    // Client already gone.
                } finally {
                    closeQuietly(client);
                }
            } catch (IOException ignored) {
                discard(client);
                closeQuietly(client);
            }
        }
    }

    private void discard(Socket client) {
        readingClients.remove(client);
        clients.remove(client);
    }

    private void handleConnection(Socket client, long requestDeadline) {
        try {
            serveConnection(client, requestDeadline);
        } catch (RequestDeadlineException deadline) {
            /* The peer exceeded the shared request budget (a byte-by-byte
             * slowloris in the request line, headers or body). Tell it so and
             * free the worker. */
            readingClients.remove(client);
            try {
                writeResponse(client, new Response(408, REQUEST_TIMEOUT_BODY), null, false);
            } catch (IOException ignored) {
                // The peer is already gone.
            }
        } catch (IOException ignored) {
            // Per-read timeout, abrupt disconnect or shutdown; the worker is free.
        } finally {
            discard(client);
            closeQuietly(client);
        }
    }

    private void serveConnection(Socket socket, long requestDeadline) throws IOException {
        socket.setSoTimeout(READ_TIMEOUT_MS);
        InputStream input = new DeadlineInputStream(socket, requestDeadline);
        LineReader reader = new LineReader(input, MAX_HEADER_BYTES);

        String requestLine = reader.readLine();
        if (requestLine == null) {
            if (reader.overflowed()) {
                writeResponse(socket, new Response(400, BAD_REQUEST_BODY), null, false);
            }
            return;
        }
        String[] parts = requestLine.split(" ", 3);
        if (parts.length < 3 || parts[0].isEmpty() || parts[1].isEmpty()) {
            writeResponse(socket, new Response(400, BAD_REQUEST_BODY), null, false);
            return;
        }
        String method = parts[0];
        String target = parts[1];
        String version = parts[2];
        if (!"HTTP/1.1".equals(version) && !"HTTP/1.0".equals(version)) {
            writeResponse(socket, new Response(400, BAD_REQUEST_BODY), null, false);
            return;
        }
        boolean head = "HEAD".equals(method);

        Map<String, String> headers = new LinkedHashMap<>();
        String line;
        while ((line = reader.readLine()) != null && !line.isEmpty()) {
            int colon = line.indexOf(':');
            if (colon > 0) {
                headers.put(
                        line.substring(0, colon).trim().toLowerCase(Locale.ROOT),
                        line.substring(colon + 1).trim());
            }
        }
        if (reader.overflowed()) {
            writeResponse(socket, new Response(400, BAD_REQUEST_BODY), null, false);
            return;
        }
        if (line == null) {
            // Connection closed halfway through the headers: nothing to answer.
            return;
        }

        String path = target;
        int query = path.indexOf('?');
        if (query >= 0) {
            path = path.substring(0, query);
        }
        boolean hasOrigin = headers.containsKey("origin");

        if ("OPTIONS".equals(method)) {
            if (hasOrigin) {
                respond(socket, new Response(403, FORBIDDEN_BODY), null, false);
            } else {
                respond(socket, new Response(204, ""), null, false);
            }
            return;
        }

        /* A client that waits for "100 Continue" before sending its body would
         * hold a worker until the request deadline. Supporting the handshake is
         * not worth the extra state: reject the expectation instead. */
        if (headers.containsKey("expect")) {
            respond(socket, new Response(417, EXPECTATION_FAILED_BODY), null, head);
            return;
        }

        if ("/mcp".equals(path)) {
            if ("POST".equals(method)) {
                Response response = handleAuthenticatedPost(socket, input, headers, hasOrigin, "/mcp");
                if (response != null) {
                    respond(socket, response, null, false);
                }
            } else {
                respond(socket, new Response(405, METHOD_NOT_ALLOWED_BODY), "POST", head);
            }
            return;
        }

        if (A2A_PATH.equals(path) || "/a2a/".equals(path)) {
            if ("POST".equals(method)) {
                /* A2A clients may append a trailing slash; the sink only has to
                 * route the canonical spelling. */
                Response response = handleAuthenticatedPost(socket, input, headers, hasOrigin, A2A_PATH);
                if (response != null) {
                    respond(socket, response, null, false);
                }
            } else {
                respond(socket, new Response(405, METHOD_NOT_ALLOWED_BODY), "POST", head);
            }
            return;
        }

        if (AGENT_CARD_PATH.equals(path)) {
            if ("GET".equals(method)) {
                /* Discovery is public by A2A design: no bearer token and no
                 * Origin rejection for this route. */
                readingClients.remove(socket);
                respond(socket, forward(buildRequest(socket, "GET", AGENT_CARD_PATH, "", headers)), null, false);
            } else {
                respond(socket, new Response(405, METHOD_NOT_ALLOWED_BODY), "GET", head);
            }
            return;
        }

        if ("GET".equals(method) && "/".equals(path)) {
            respond(socket, new Response(200, STATUS_BODY), null, false);
            return;
        }

        respond(socket, new Response(404, NOT_FOUND_BODY), null, head);
    }

    /**
     * Applies the authenticated-POST envelope (Origin, bearer, body limits) and
     * forwards the body to the handler under {@code forwardedPath}.
     *
     * @return a response, or null when the connection died while reading the body
     */
    private Response handleAuthenticatedPost(Socket socket, InputStream input, Map<String, String> headers,
            boolean hasOrigin, String forwardedPath) throws IOException {
        if (hasOrigin) {
            return new Response(403, FORBIDDEN_BODY);
        }
        if (!isAuthorized(headers.get("authorization"))) {
            return new Response(401, UNAUTHORIZED_BODY);
        }
        String transferEncoding = headers.get("transfer-encoding");
        if (transferEncoding != null && transferEncoding.toLowerCase(Locale.ROOT).contains("chunked")) {
            return new Response(411, LENGTH_REQUIRED_BODY);
        }
        String contentLength = headers.get("content-length");
        if (contentLength == null || contentLength.trim().isEmpty()) {
            return new Response(411, LENGTH_REQUIRED_BODY);
        }
        /* RFC 9110 allows only 1*DIGIT. Accepting signs or whitespace here would
         * let a proxy and this server disagree about where a body starts. */
        String rawLength = contentLength.trim();
        if (!rawLength.matches("[0-9]+")) {
            return new Response(400, BAD_REQUEST_BODY);
        }
        long length;
        try {
            length = Long.parseLong(rawLength);
        } catch (NumberFormatException invalid) {
            return new Response(400, BAD_REQUEST_BODY);
        }
        if (length > MAX_BODY_BYTES) {
            return new Response(413, TOO_LARGE_BODY);
        }
        byte[] body = readBody(input, (int) length);
        if (body == null) {
            return null;
        }
        /* Reading a slow body can straddle token rotation. */
        if (!isAuthorized(headers.get("authorization"))) {
            return new Response(401, UNAUTHORIZED_BODY);
        }
        /* The body is complete: this connection is now waiting on the WebView,
         * not on the network. stop() must not close it before the 503 is sent. */
        readingClients.remove(socket);
        return forward(buildRequest(
                socket, "POST", forwardedPath, new String(body, StandardCharsets.UTF_8), headers));
    }

    private static Request buildRequest(
            Socket socket, String method, String path, String body, Map<String, String> headers) {
        String remote = socket.getInetAddress() == null ? "" : socket.getInetAddress().getHostAddress();
        String userAgent = headers.get("user-agent");
        return new Request(method, path, remote, userAgent == null ? "" : userAgent, body);
    }

    private Response forward(Request request) {
        if (handler == null) {
            return new Response(503, NOT_READY_BODY);
        }
        CompletableFuture<Response> delivery = new CompletableFuture<>();
        inFlight.add(delivery);
        if (!running) {
            inFlight.remove(delivery);
            return new Response(503, NOT_READY_BODY);
        }
        CompletableFuture<Response> handled;
        try {
            handled = handler.handle(request);
        } catch (RuntimeException error) {
            inFlight.remove(delivery);
            return new Response(503, NOT_READY_BODY);
        }
        if (handled == null) {
            inFlight.remove(delivery);
            return new Response(503, NOT_READY_BODY);
        }
        handled.whenComplete((response, error) -> {
            if (error != null || response == null) {
                delivery.complete(new Response(503, NOT_READY_BODY));
            } else {
                delivery.complete(response);
            }
        });
        try {
            return delivery.get();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return new Response(503, NOT_READY_BODY);
        } catch (java.util.concurrent.ExecutionException failed) {
            return new Response(503, NOT_READY_BODY);
        } finally {
            inFlight.remove(delivery);
        }
    }

    private boolean isAuthorized(String authorization) {
        String expected = token;
        if (expected == null || expected.isEmpty() || authorization == null) {
            return false;
        }
        String prefix = "Bearer ";
        if (authorization.length() < prefix.length()
                || !authorization.regionMatches(true, 0, prefix, 0, prefix.length())) {
            return false;
        }
        byte[] provided = authorization.substring(prefix.length()).trim().getBytes(StandardCharsets.UTF_8);
        byte[] wanted = expected.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(provided, wanted);
    }

    /**
     * Reads the body through the deadline stream. Returns null on EOF or socket
     * failure; a request-deadline breach propagates as an IOException so the
     * caller can answer 408.
     */
    private static byte[] readBody(InputStream input, int length) throws IOException {
        if (length == 0) {
            return new byte[0];
        }
        byte[] body = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read;
            try {
                read = input.read(body, offset, length - offset);
            } catch (RequestDeadlineException deadline) {
                throw deadline;
            } catch (IOException failure) {
                return null;
            }
            if (read < 0) {
                return null;
            }
            offset += read;
        }
        return body;
    }

    /** Marks the connection as no longer waiting on the network. */
    private void respond(Socket socket, Response response, String allow, boolean suppressBody) throws IOException {
        readingClients.remove(socket);
        writeResponse(socket, response, allow, suppressBody);
    }

    private static void writeResponse(Socket socket, Response response, String allow, boolean suppressBody)
            throws IOException {
        int status = response == null ? 500 : response.status;
        if (status < 100 || status > 599) {
            status = 500;
        }
        String body = response == null || response.body == null ? "" : response.body;
        if (status == 202 || status == 204 || suppressBody) {
            body = "";
        }
        byte[] bodyBytes = body.getBytes(StandardCharsets.UTF_8);
        StringBuilder head = new StringBuilder(160);
        head.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        head.append("Content-Type: application/json; charset=utf-8\r\n");
        head.append("Cache-Control: no-store\r\n");
        head.append("Connection: close\r\n");
        if (allow != null) {
            head.append("Allow: ").append(allow).append("\r\n");
        }
        if (status != 204) {
            head.append("Content-Length: ").append(bodyBytes.length).append("\r\n");
        }
        head.append("\r\n");
        OutputStream output = socket.getOutputStream();
        output.write(head.toString().getBytes(StandardCharsets.US_ASCII));
        if (bodyBytes.length > 0) {
            output.write(bodyBytes);
        }
        output.flush();
    }

    private static String reason(int status) {
        switch (status) {
            case 200:
                return "OK";
            case 202:
                return "Accepted";
            case 204:
                return "No Content";
            case 400:
                return "Bad Request";
            case 401:
                return "Unauthorized";
            case 403:
                return "Forbidden";
            case 404:
                return "Not Found";
            case 405:
                return "Method Not Allowed";
            case 408:
                return "Request Timeout";
            case 411:
                return "Length Required";
            case 413:
                return "Payload Too Large";
            case 417:
                return "Expectation Failed";
            case 500:
                return "Internal Server Error";
            case 503:
                return "Service Unavailable";
            case 504:
                return "Gateway Timeout";
            default:
                return "Status";
        }
    }

    private static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // Already closed.
        }
    }

    /** Signals that the shared request budget is exhausted. */
    private static final class RequestDeadlineException extends IOException {

        RequestDeadlineException() {
            super("Request deadline exceeded");
        }
    }

    /**
     * Buffered stream that arms the socket read timeout from the remaining
     * whole-request budget before every read. A peer cannot stretch a request by
     * keeping each individual read under the old per-read timeout.
     */
    private static final class DeadlineInputStream extends BufferedInputStream {

        private final Socket socket;
        private final long deadlineNanos;
        private int armedTimeoutMs = -1;

        DeadlineInputStream(Socket socket, long deadlineNanos) throws IOException {
            super(socket.getInputStream());
            this.socket = socket;
            this.deadlineNanos = deadlineNanos;
        }

        @Override
        public int read() throws IOException {
            armDeadline();
            try {
                return super.read();
            } catch (SocketTimeoutException timeout) {
                throw rethrowTimeout(timeout);
            }
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            armDeadline();
            try {
                return super.read(buffer, offset, length);
            } catch (SocketTimeoutException timeout) {
                throw rethrowTimeout(timeout);
            }
        }

        private void armDeadline() throws IOException {
            long remainingMs = TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime());
            if (remainingMs <= 0) {
                throw new RequestDeadlineException();
            }
            int timeoutMs = (int) Math.max(1L, Math.min(READ_TIMEOUT_MS, remainingMs));
            if (timeoutMs != armedTimeoutMs) {
                socket.setSoTimeout(timeoutMs);
                armedTimeoutMs = timeoutMs;
            }
        }

        private IOException rethrowTimeout(SocketTimeoutException timeout) {
            if (System.nanoTime() - deadlineNanos >= 0) {
                return new RequestDeadlineException();
            }
            return timeout;
        }
    }

    /** Reads CRLF lines while enforcing a total byte budget. */
    private static final class LineReader {

        private final InputStream input;
        private final int limit;
        private int total;
        private boolean overflowed;

        LineReader(InputStream input, int limit) {
            this.input = input;
            this.limit = limit;
        }

        boolean overflowed() {
            return overflowed;
        }

        String readLine() throws IOException {
            ByteArrayOutputStream line = new ByteArrayOutputStream(128);
            int current;
            while ((current = input.read()) >= 0) {
                total++;
                if (total > limit) {
                    overflowed = true;
                    return null;
                }
                if (current == '\n') {
                    byte[] bytes = line.toByteArray();
                    int length = bytes.length;
                    if (length > 0 && bytes[length - 1] == '\r') {
                        length--;
                    }
                    return new String(bytes, 0, length, StandardCharsets.ISO_8859_1);
                }
                line.write(current);
            }
            return null;
        }
    }
}
