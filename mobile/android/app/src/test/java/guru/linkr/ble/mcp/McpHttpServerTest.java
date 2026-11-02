package guru.linkr.ble.mcp;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.After;
import org.junit.Test;

/**
 * Host-JVM tests for the transport envelope. The JS side is not involved: a
 * fake {@link McpHttpServer.Handler} stands in for the WebView.
 */
public class McpHttpServerTest {

    private static final String TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String ROTATED_TOKEN = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    private static final String WRONG_TOKEN = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    private static final String A2A_PATH = "/a2a";
    private static final String AGENT_CARD_PATH = "/.well-known/agent-card.json";
    private static final String AGENT_CARD_BODY =
            "{\"name\":\"linkr-bee\",\"version\":\"0.1.0\",\"skills\":[]}";

    private McpHttpServer server;

    @After
    public void tearDown() {
        if (server != null) {
            server.stop();
            server = null;
        }
    }

    // ------------------------------------------------------------------ routes

    @Test
    public void statusPageIsPublic() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("GET / must not reach the WebView sink");
        });

        RawResponse response = exchange(started.getPort(), http("GET", "/", headers(), null));

        assertEquals(200, response.status);
        assertEquals(
                "{\"name\":\"linkr-bee-mcp\",\"version\":\"0.1.0\",\"mcp\":\"/mcp\",\"a2a\":\"/a2a\","
                        + "\"agentCard\":\"/.well-known/agent-card.json\"}",
                response.body);
        assertEquals("application/json; charset=utf-8", response.headers.get("content-type"));
        assertEquals("no-store", response.headers.get("cache-control"));
    }

    @Test
    public void missingTokenIsUnauthorized() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        McpHttpServer started = start(request -> {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}"));
        });

        Map<String, String> requestHeaders = headers("Content-Length", "2");
        RawResponse response = exchange(started.getPort(), http("POST", "/mcp", requestHeaders, bytes("{}")));

        assertEquals(401, response.status);
        assertEquals(0, calls.get());
    }

    @Test
    public void wrongTokenIsUnauthorized() throws Exception {
        McpHttpServer started = start(request ->
                CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}")));

        Map<String, String> requestHeaders = headers(
                "Authorization", "Bearer " + WRONG_TOKEN,
                "Content-Length", "2");
        RawResponse response = exchange(started.getPort(), http("POST", "/mcp", requestHeaders, bytes("{}")));

        assertEquals(401, response.status);
    }

    @Test
    public void authenticatedPostIsForwardedAndResponseIsReturned() throws Exception {
        AtomicReference<McpHttpServer.Request> captured = new AtomicReference<>();
        McpHttpServer started = start(request -> {
            captured.set(request);
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{\"ok\":true}"));
        });
        String body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}";

        Map<String, String> requestHeaders = authorizedHeaders(body);
        requestHeaders.put("User-Agent", "mcp-test-client");
        RawResponse response = exchange(started.getPort(), http("POST", "/mcp", requestHeaders, bytes(body)));

        assertEquals(200, response.status);
        assertEquals("{\"ok\":true}", response.body);
        assertEquals("application/json; charset=utf-8", response.headers.get("content-type"));
        assertEquals("no-store", response.headers.get("cache-control"));
        assertEquals("close", response.headers.get("connection"));

        McpHttpServer.Request request = captured.get();
        assertNotNull(request);
        assertEquals("POST", request.method);
        assertEquals("/mcp", request.path);
        assertEquals(body, request.body);
        assertEquals("mcp-test-client", request.userAgent);
        assertFalse(request.remote.isEmpty());
    }

    // ------------------------------------------------------------ a2a transport

    @Test
    public void postA2aWithoutTokenIsUnauthorized() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        McpHttpServer started = start(request -> {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}"));
        });

        Map<String, String> requestHeaders = headers("Content-Length", "2");
        RawResponse response = exchange(started.getPort(), http("POST", A2A_PATH, requestHeaders, bytes("{}")));

        assertEquals(401, response.status);
        assertEquals(0, calls.get());
    }

    @Test
    public void postA2aWithWrongTokenIsUnauthorized() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        McpHttpServer started = start(request -> {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}"));
        });

        Map<String, String> requestHeaders = headers(
                "Authorization", "Bearer " + WRONG_TOKEN,
                "Content-Length", "2");
        RawResponse response = exchange(started.getPort(), http("POST", A2A_PATH, requestHeaders, bytes("{}")));

        assertEquals(401, response.status);
        assertEquals(0, calls.get());
    }

    @Test
    public void postA2aWithOriginIsForbidden() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        McpHttpServer started = start(request -> {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}"));
        });
        Map<String, String> requestHeaders = a2aHeaders("{}");
        requestHeaders.put("Origin", "http://evil.example");

        RawResponse response = exchange(started.getPort(), http("POST", A2A_PATH, requestHeaders, bytes("{}")));

        assertEquals(403, response.status);
        assertEquals(0, calls.get());
    }

    @Test
    public void postA2aWithoutContentLengthIsLengthRequired() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("A body without Content-Length must not reach the WebView sink");
        });

        RawResponse response = exchange(
                started.getPort(),
                http("POST", A2A_PATH, headers("Authorization", "Bearer " + TOKEN), null));

        assertEquals(411, response.status);
    }

    @Test
    public void postA2aChunkedEncodingIsLengthRequired() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("Chunked bodies must not reach the WebView sink");
        });

        Map<String, String> requestHeaders = headers(
                "Authorization", "Bearer " + TOKEN,
                "Transfer-Encoding", "chunked");
        RawResponse response = exchange(started.getPort(), http("POST", A2A_PATH, requestHeaders, null));

        assertEquals(411, response.status);
    }

    @Test
    public void postA2aOversizedBodyIsRejected() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("Oversized bodies must not reach the WebView sink");
        });

        Map<String, String> requestHeaders = headers(
                "Authorization", "Bearer " + TOKEN,
                "Content-Length", String.valueOf(McpHttpServer.MAX_BODY_BYTES + 1));
        RawResponse response = exchange(started.getPort(), http("POST", A2A_PATH, requestHeaders, null));

        assertEquals(413, response.status);
    }

    @Test
    public void authenticatedPostA2aIsForwardedAndResponseReturned() throws Exception {
        AtomicReference<McpHttpServer.Request> captured = new AtomicReference<>();
        McpHttpServer started = start(request -> {
            captured.set(request);
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{\"result\":{\"ok\":true}}"));
        });
        String body = "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"message/send\",\"params\":{}}";

        Map<String, String> requestHeaders = a2aHeaders(body);
        requestHeaders.put("User-Agent", "a2a-test-client");
        RawResponse response = exchange(started.getPort(), http("POST", A2A_PATH, requestHeaders, bytes(body)));

        assertEquals(200, response.status);
        assertEquals("{\"result\":{\"ok\":true}}", response.body);
        assertEquals("application/json; charset=utf-8", response.headers.get("content-type"));
        assertEquals("no-store", response.headers.get("cache-control"));

        McpHttpServer.Request request = captured.get();
        assertNotNull(request);
        assertEquals("POST", request.method);
        assertEquals(A2A_PATH, request.path);
        assertEquals(body, request.body);
        assertEquals("a2a-test-client", request.userAgent);
        assertFalse(request.remote.isEmpty());
    }

    @Test
    public void postA2aTrailingSlashAliasForwardsCanonicalPath() throws Exception {
        AtomicReference<McpHttpServer.Request> captured = new AtomicReference<>();
        McpHttpServer started = start(request -> {
            captured.set(request);
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{\"ok\":true}"));
        });
        String body = "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"ping\"}";

        RawResponse response = exchange(
                started.getPort(), http("POST", "/a2a/", a2aHeaders(body), bytes(body)));

        assertEquals(200, response.status);
        assertEquals("{\"ok\":true}", response.body);
        assertNotNull(captured.get());
        assertEquals("POST", captured.get().method);
        assertEquals(A2A_PATH, captured.get().path);
        assertEquals(body, captured.get().body);
    }

    @Test
    public void agentCardIsPublicAndForwardedWithoutAuthorization() throws Exception {
        AtomicReference<McpHttpServer.Request> captured = new AtomicReference<>();
        McpHttpServer started = start(request -> {
            captured.set(request);
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, AGENT_CARD_BODY));
        });

        RawResponse response = exchange(started.getPort(), http("GET", AGENT_CARD_PATH, headers(), null));

        assertEquals(200, response.status);
        assertEquals(AGENT_CARD_BODY, response.body);
        assertEquals("application/json; charset=utf-8", response.headers.get("content-type"));
        assertEquals("no-store", response.headers.get("cache-control"));

        McpHttpServer.Request request = captured.get();
        assertNotNull("the public card must reach the WebView sink", request);
        assertEquals("GET", request.method);
        assertEquals(AGENT_CARD_PATH, request.path);
        assertEquals("", request.body);
        assertEquals("", request.userAgent);
    }

    @Test
    public void agentCardIgnoresOriginHeader() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        McpHttpServer started = start(request -> {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, AGENT_CARD_BODY));
        });
        Map<String, String> requestHeaders = headers("Origin", "http://browser.example");

        RawResponse response = exchange(started.getPort(), http("GET", AGENT_CARD_PATH, requestHeaders, null));

        assertEquals("a browser may read the public card", 200, response.status);
        assertEquals(1, calls.get());
    }

    @Test
    public void getAndDeleteOnA2aAreMethodNotAllowed() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("Only POST /a2a may reach the WebView sink");
        });

        for (String target : new String[] {A2A_PATH, "/a2a/"}) {
            RawResponse get = exchange(started.getPort(), http("GET", target, headers(), null));
            assertEquals(405, get.status);
            assertEquals("POST", get.headers.get("allow"));

            RawResponse delete = exchange(started.getPort(), http("DELETE", target, headers(), null));
            assertEquals(405, delete.status);
            assertEquals("POST", delete.headers.get("allow"));
        }
    }

    @Test
    public void postAndDeleteOnAgentCardAreMethodNotAllowed() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("Only GET " + AGENT_CARD_PATH + " may reach the WebView sink");
        });

        RawResponse post = exchange(
                started.getPort(), http("POST", AGENT_CARD_PATH, headers("Content-Length", "2"), bytes("{}")));
        assertEquals(405, post.status);
        assertEquals("GET", post.headers.get("allow"));

        RawResponse delete = exchange(started.getPort(), http("DELETE", AGENT_CARD_PATH, headers(), null));
        assertEquals(405, delete.status);
        assertEquals("GET", delete.headers.get("allow"));
    }

    @Test
    public void acceptedResponseHasEmptyBody() throws Exception {
        McpHttpServer started = start(request ->
                CompletableFuture.completedFuture(new McpHttpServer.Response(202, "must not be written")));

        RawResponse response = exchange(
                started.getPort(), http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}")));

        assertEquals(202, response.status);
        assertEquals("", response.body);
        assertEquals("0", response.headers.get("content-length"));
    }

    @Test
    public void originHeaderIsForbiddenOnPost() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        McpHttpServer started = start(request -> {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}"));
        });
        Map<String, String> requestHeaders = authorizedHeaders("{}");
        requestHeaders.put("Origin", "http://evil.example");

        RawResponse response = exchange(started.getPort(), http("POST", "/mcp", requestHeaders, bytes("{}")));

        assertEquals(403, response.status);
        assertEquals(0, calls.get());
    }

    @Test
    public void originIsCheckedBeforeAuthorization() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        McpHttpServer started = start(request -> {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}"));
        });
        /* No Authorization header: a browser (or DNS-rebinding page) must be
         * rejected by the Origin check before the missing token is reported. */
        Map<String, String> requestHeaders = headers("Origin", "http://evil.example");

        RawResponse response = exchange(started.getPort(), http("POST", "/mcp", requestHeaders, null));

        assertEquals(403, response.status);
        assertEquals(0, calls.get());
    }

    @Test
    public void originHeaderIsForbiddenOnOptions() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("OPTIONS must not reach the WebView sink");
        });
        Map<String, String> requestHeaders = headers("Origin", "http://evil.example");

        RawResponse response = exchange(started.getPort(), http("OPTIONS", "/mcp", requestHeaders, null));

        assertEquals(403, response.status);
    }

    @Test
    public void optionsWithoutOriginIsNoContent() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("OPTIONS must not reach the WebView sink");
        });

        RawResponse response = exchange(started.getPort(), http("OPTIONS", "/mcp", headers(), null));

        assertEquals(204, response.status);
        assertEquals("", response.body);
    }

    @Test
    public void getAndDeleteOnMcpAreMethodNotAllowed() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("Only POST /mcp may reach the WebView sink");
        });

        RawResponse get = exchange(started.getPort(), http("GET", "/mcp", headers(), null));
        assertEquals(405, get.status);
        assertEquals("POST", get.headers.get("allow"));

        RawResponse delete = exchange(started.getPort(), http("DELETE", "/mcp", headers(), null));
        assertEquals(405, delete.status);
        assertEquals("POST", delete.headers.get("allow"));
    }

    @Test
    public void unknownPathIsNotFound() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("Unknown paths must not reach the WebView sink");
        });

        RawResponse response = exchange(started.getPort(), http("POST", "/nope", authorizedHeaders("{}"), bytes("{}")));

        assertEquals(404, response.status);
    }

    // -------------------------------------------------------------- body limits

    @Test
    public void missingContentLengthIsLengthRequired() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("Missing Content-Length must not reach the WebView sink");
        });

        RawResponse response = exchange(
                started.getPort(),
                http("POST", "/mcp", headers("Authorization", "Bearer " + TOKEN), null));

        assertEquals(411, response.status);
    }

    @Test
    public void invalidContentLengthIsBadRequest() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("Invalid Content-Length must not reach the WebView sink");
        });

        Map<String, String> requestHeaders = headers(
                "Authorization", "Bearer " + TOKEN,
                "Content-Length", "not-a-number");
        RawResponse response = exchange(started.getPort(), http("POST", "/mcp", requestHeaders, null));

        assertEquals(400, response.status);
    }

    @Test
    public void signedContentLengthIsBadRequest() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("A non-RFC Content-Length must not reach the WebView sink");
        });

        Map<String, String> requestHeaders = headers(
                "Authorization", "Bearer " + TOKEN,
                "Content-Length", "+2");
        RawResponse response = exchange(started.getPort(), http("POST", "/mcp", requestHeaders, null));

        assertEquals(400, response.status);
    }

    @Test
    public void chunkedEncodingIsLengthRequired() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("Chunked bodies must not reach the WebView sink");
        });

        Map<String, String> requestHeaders = headers(
                "Authorization", "Bearer " + TOKEN,
                "Transfer-Encoding", "chunked");
        RawResponse response = exchange(started.getPort(), http("POST", "/mcp", requestHeaders, null));

        assertEquals(411, response.status);
    }

    @Test
    public void oversizedBodyIsRejected() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("Oversized bodies must not reach the WebView sink");
        });

        Map<String, String> requestHeaders = headers(
                "Authorization", "Bearer " + TOKEN,
                "Content-Length", String.valueOf(McpHttpServer.MAX_BODY_BYTES + 1));
        RawResponse response = exchange(started.getPort(), http("POST", "/mcp", requestHeaders, null));

        assertEquals(413, response.status);
    }

    // ------------------------------------------------------------------ errors

    @Test
    public void handlerFailureReturnsServiceUnavailable() throws Exception {
        McpHttpServer started = start(request -> {
            throw new IllegalStateException("sink exploded");
        });

        RawResponse response = exchange(
                started.getPort(), http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}")));

        assertEquals(503, response.status);
        assertEquals(McpHttpServer.NOT_READY_BODY, response.body);
    }

    @Test
    public void nullHandlerFutureReturnsServiceUnavailable() throws Exception {
        McpHttpServer started = start(request -> null);

        RawResponse response = exchange(
                started.getPort(), http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}")));

        assertEquals(503, response.status);
        assertEquals(McpHttpServer.NOT_READY_BODY, response.body);
    }

    @Test
    public void handlerWithNoWebViewReturnsServiceUnavailable() throws Exception {
        McpHttpServer started = start(request ->
                CompletableFuture.completedFuture(new McpHttpServer.Response(503, McpHttpServer.NOT_READY_BODY)));

        RawResponse response = exchange(
                started.getPort(), http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}")));

        assertEquals(503, response.status);
    }

    // -------------------------------------------------------------- lifecycle

    @Test
    public void stopAnswersAPendingRequestWithServiceUnavailableAndIsIdempotent() throws Exception {
        CountDownLatch handlerCalled = new CountDownLatch(1);
        McpHttpServer started = new McpHttpServer(request -> {
            handlerCalled.countDown();
            return new CompletableFuture<>();
        }, TOKEN, false);
        server = started;
        started.start(0);

        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<RawResponse> pending = executor.submit(() ->
                    exchange(started.getPort(), http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}"))));
            assertTrue("handler should receive the request", handlerCalled.await(5, TimeUnit.SECONDS));

            started.stop();

            RawResponse response = pending.get(5, TimeUnit.SECONDS);
            assertEquals(503, response.status);
            assertEquals(McpHttpServer.NOT_READY_BODY, response.body);
            assertFalse(started.isRunning());

            started.stop();
            assertFalse(started.isRunning());
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    public void stopClosesSocketsThatWereStillQueued() throws Exception {
        CountDownLatch busy = new CountDownLatch(McpHttpServer.MAX_CONCURRENT_REQUESTS);
        CountDownLatch release = new CountDownLatch(1);
        McpHttpServer started = start(request -> {
            busy.countDown();
            try {
                release.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
            }
            return new CompletableFuture<>();
        });
        List<Socket> clients = new ArrayList<>();
        try {
            for (int i = 0; i < McpHttpServer.MAX_CONCURRENT_REQUESTS; i++) {
                Socket socket = new Socket(InetAddress.getLoopbackAddress(), started.getPort());
                clients.add(socket);
                socket.getOutputStream().write(http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}")));
            }
            assertTrue(busy.await(5, TimeUnit.SECONDS));
            Socket queued = new Socket(InetAddress.getLoopbackAddress(), started.getPort());
            clients.add(queued);
            queued.getOutputStream().write(http("GET", "/", headers(), null));
            // Barrier only: ensure the accepted socket really is queued before
            // stopping. The assertion below observes socket closure, not a field.
            Field executorField = McpHttpServer.class.getDeclaredField("executor");
            executorField.setAccessible(true);
            ThreadPoolExecutor pool = (ThreadPoolExecutor) executorField.get(started);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (pool.getQueue().isEmpty() && System.nanoTime() < deadline) Thread.sleep(10);
            assertFalse("the ninth connection must be waiting in the queue", pool.getQueue().isEmpty());
            started.stop();
            queued.setSoTimeout(1000);
            try {
                assertEquals(-1, queued.getInputStream().read());
            } catch (java.net.SocketException closed) {
                // Reset is also a valid close of an unparsed request.
            }
            Field clientsField = McpHttpServer.class.getDeclaredField("clients");
            clientsField.setAccessible(true);
            java.util.Set<?> tracked = (java.util.Set<?>) clientsField.get(started);
            long cleanupDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (!tracked.isEmpty() && System.nanoTime() < cleanupDeadline) Thread.sleep(5);
            assertTrue("stopped queued sockets must not remain retained", tracked.isEmpty());
        } finally {
            release.countDown();
            for (Socket client : clients) client.close();
        }
    }

    @Test
    public void tokenRotationRejectsAnOldTokenWhoseBodyWasStillBeingRead() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        McpHttpServer started = start(request -> {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}"));
        });
        try (Socket client = new Socket(InetAddress.getLoopbackAddress(), started.getPort())) {
            client.setSoTimeout(5000);
            client.getOutputStream().write(http("POST", "/mcp", authorizedHeaders("{}"), null));
            // Wait until the body read blocks, after the initial auth check.
            boolean readingBody = false;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (!readingBody && System.nanoTime() < deadline) {
                for (StackTraceElement[] trace : Thread.getAllStackTraces().values()) {
                    for (StackTraceElement frame : trace) {
                        if (frame.getClassName().equals(McpHttpServer.class.getName())
                                && frame.getMethodName().equals("readBody")) readingBody = true;
                    }
                }
                if (!readingBody) Thread.sleep(10);
            }
            assertTrue("server must have authenticated and started reading the body", readingBody);
            started.setToken(ROTATED_TOKEN);
            client.getOutputStream().write(bytes("{}"));
            assertEquals(401, readResponse(client.getInputStream()).status);
            assertEquals(0, calls.get());
        }
    }

    @Test
    public void tokenRotationInvalidatesThePreviousTokenWithoutRestart() throws Exception {
        McpHttpServer started = start(request ->
                CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}")));

        RawResponse before = exchange(started.getPort(),
                http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}")));
        assertEquals(200, before.status);

        started.setToken(ROTATED_TOKEN);

        RawResponse stale = exchange(started.getPort(),
                http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}")));
        assertEquals(401, stale.status);

        Map<String, String> rotatedHeaders = headers(
                "Authorization", "Bearer " + ROTATED_TOKEN,
                "Content-Length", "2");
        RawResponse rotated = exchange(started.getPort(), http("POST", "/mcp", rotatedHeaders, bytes("{}")));
        assertEquals(200, rotated.status);
    }

    @Test
    public void failedBindLeavesTheServerStoppedAndARetryCanBind() throws Exception {
        McpHttpServer first = start(request ->
                CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}")));
        int busyPort = first.getPort();

        McpHttpServer retry = new McpHttpServer(request ->
                CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}")), TOKEN, false);
        server = retry;
        try {
            retry.start(busyPort);
            fail("binding an occupied port must throw");
        } catch (IOException expected) {
            // The busy port must fail, not silently report a running server.
        }
        assertFalse(retry.isRunning());
        assertEquals(-1, retry.getPort());

        first.stop();
        retry.start(busyPort);
        assertTrue(retry.isRunning());
        RawResponse response = exchange(retry.getPort(),
                http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}")));
        assertEquals(200, response.status);
    }

    @Test
    public void restartAfterStopBindsAndServesAgain() throws Exception {
        McpHttpServer started = start(request ->
                CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}")));
        started.stop();
        assertFalse(started.isRunning());

        started.start(0);

        assertTrue(started.isRunning());
        RawResponse response = exchange(started.getPort(),
                http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}")));
        assertEquals(200, response.status);
    }

    // ---------------------------------------------------------- slowloris guards

    @Test
    public void slowHeaderTrickleIsCutAtTheRequestDeadline() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        /* 1.5 s deadline: every individual read is far below the 10 s per-read
         * timeout, so only the shared deadline can end this request. */
        McpHttpServer started = start(request -> {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}"));
        }, 1_500);
        try (Socket client = new Socket(InetAddress.getLoopbackAddress(), started.getPort())) {
            client.setSoTimeout(10_000);
            OutputStream output = client.getOutputStream();
            output.write(bytes("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: "));
            output.flush();
            long startNanos = System.nanoTime();
            byte[] oneByte = new byte[] {'a'};
            while (System.nanoTime() - startNanos < TimeUnit.SECONDS.toNanos(8)) {
                if (client.getInputStream().available() > 0) {
                    break;
                }
                try {
                    output.write(oneByte);
                    output.flush();
                } catch (IOException peerGone) {
                    break;
                }
                Thread.sleep(100);
            }
            client.setSoTimeout(5_000);
            RawResponse response = null;
            try {
                response = readResponse(client.getInputStream());
            } catch (IOException closedByDeadline) {
                // A hard close is also a valid "abort" for an over-budget request.
            }
            long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);
            if (response != null) {
                assertEquals("an over-budget trickle must be rejected, not answered", 408, response.status);
            }
            assertTrue("the shared deadline must cut the trickle well before the 10 s per-read"
                    + " timeout, took " + elapsedMs + " ms", elapsedMs < 6_000);
            assertEquals(0, calls.get());
        }
    }

    @Test
    public void heldConnectionsCannotBlockAnAuthenticatedRequestPastTheDeadline() throws Exception {
        McpHttpServer started = start(request ->
                CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{\"ok\":true}")), 1_500);
        List<Socket> held = new ArrayList<>();
        try {
            for (int index = 0; index < McpHttpServer.MAX_CONCURRENT_REQUESTS; index++) {
                Socket socket = new Socket(InetAddress.getLoopbackAddress(), started.getPort());
                held.add(socket);
                socket.getOutputStream().write(bytes("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: "));
                socket.getOutputStream().flush();
            }
            /* Let all eight workers enter the read phase with partial headers. */
            Thread.sleep(300);

            long startNanos = System.nanoTime();
            RawResponse response = exchange(started.getPort(),
                    http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}")));
            long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);

            assertEquals(200, response.status);
            assertTrue("the queued authenticated request must be served once the slowloris"
                    + " deadline releases the workers, took " + elapsedMs + " ms", elapsedMs < 8_000);
        } finally {
            for (Socket socket : held) {
                socket.close();
            }
        }
    }

    @Test
    public void stopClosesASocketBlockedInRead() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("a partial header must never reach the WebView sink");
        });
        try (Socket client = new Socket(InetAddress.getLoopbackAddress(), started.getPort())) {
            client.setSoTimeout(5_000);
            client.getOutputStream().write(bytes("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Wait: "));
            client.getOutputStream().flush();
            assertTrue("the worker must be blocked in a read", awaitServerRead(5_000));

            started.stop();

            client.setSoTimeout(2_000);
            int value;
            try {
                value = client.getInputStream().read();
            } catch (java.net.SocketException closed) {
                value = -1;
            }
            assertEquals("the client must see EOF/reset, not hang past stop()", -1, value);
        }
    }

    // ---------------------------------------------------------- parser hardening

    @Test
    public void expectContinueIsRejectedWith417() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        McpHttpServer started = start(request -> {
            calls.incrementAndGet();
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}"));
        });
        Map<String, String> requestHeaders = headers(
                "Authorization", "Bearer " + TOKEN,
                "Content-Length", "2",
                "Expect", "100-continue");

        RawResponse response = exchange(started.getPort(), http("POST", "/mcp", requestHeaders, null));

        assertEquals(417, response.status);
        assertEquals(0, calls.get());
    }

    @Test
    public void headOnMcpIsMethodNotAllowedWithoutBody() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("HEAD /mcp must not reach the WebView sink");
        });

        RawResponse response = exchange(started.getPort(), http("HEAD", "/mcp", headers(), null));

        assertEquals(405, response.status);
        assertEquals("POST", response.headers.get("allow"));
        assertEquals("", response.body);
        assertEquals("0", response.headers.get("content-length"));
    }

    @Test
    public void putAndPatchOnMcpAreMethodNotAllowed() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("Only POST /mcp may reach the WebView sink");
        });

        for (String method : new String[] {"PUT", "PATCH"}) {
            RawResponse response = exchange(started.getPort(), http(method, "/mcp", headers(), null));
            assertEquals(405, response.status);
            assertEquals("POST", response.headers.get("allow"));
        }
    }

    @Test
    public void unsupportedHttpVersionIsBadRequest() throws Exception {
        McpHttpServer started = start(request -> {
            throw new AssertionError("An unsupported HTTP version must not reach the WebView sink");
        });

        RawResponse response = exchange(
                started.getPort(), httpVersion("GET", "/", "HTTP/2.0", headers(), null));

        assertEquals(400, response.status);
    }

    // ----------------------------------------------------------------- helpers

    @Test
    public void queuedRequestDeadlineIncludesQueueWait() throws Exception {
        CountDownLatch busy = new CountDownLatch(McpHttpServer.MAX_CONCURRENT_REQUESTS);
        List<CompletableFuture<McpHttpServer.Response>> held = new java.util.concurrent.CopyOnWriteArrayList<>();
        AtomicInteger calls = new AtomicInteger();
        McpHttpServer started = start(request -> {
            if (calls.incrementAndGet() <= McpHttpServer.MAX_CONCURRENT_REQUESTS) {
                CompletableFuture<McpHttpServer.Response> future = new CompletableFuture<>();
                held.add(future);
                busy.countDown();
                return future;
            }
            return CompletableFuture.completedFuture(new McpHttpServer.Response(200, "{}"));
        }, 1000);
        List<Socket> sockets = new ArrayList<>();
        try {
            for (int index = 0; index < McpHttpServer.MAX_CONCURRENT_REQUESTS; index++) {
                Socket socket = new Socket(InetAddress.getLoopbackAddress(), started.getPort());
                sockets.add(socket);
                socket.getOutputStream().write(http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}")));
            }
            assertTrue(busy.await(5, TimeUnit.SECONDS));
            Socket queued = new Socket(InetAddress.getLoopbackAddress(), started.getPort());
            sockets.add(queued);
            queued.setSoTimeout(5000);
            queued.getOutputStream().write(http("POST", "/mcp", authorizedHeaders("{}"), bytes("{}")));
            Field field = McpHttpServer.class.getDeclaredField("executor");
            field.setAccessible(true);
            ThreadPoolExecutor pool = (ThreadPoolExecutor) field.get(started);
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (pool.getQueue().isEmpty() && System.nanoTime() < until) Thread.sleep(5);
            assertFalse(pool.getQueue().isEmpty());
            Thread.sleep(1100);
            for (CompletableFuture<McpHttpServer.Response> future : held) {
                future.complete(new McpHttpServer.Response(200, "{}"));
            }
            ByteArrayOutputStream response = new ByteArrayOutputStream();
            byte[] chunk = new byte[1024];
            int count;
            try {
                while ((count = queued.getInputStream().read(chunk)) >= 0) response.write(chunk, 0, count);
            } catch (java.net.SocketException expired) {
                // Closing an expired socket with unread bytes can reset TCP.
                // The invariant below is that no expired request is forwarded.
            }
            if (response.size() > 0) {
                assertTrue(response.toString("UTF-8"), response.toString("UTF-8").startsWith("HTTP/1.1 408 "));
            }
            assertEquals(McpHttpServer.MAX_CONCURRENT_REQUESTS, calls.get());
        } finally {
            for (CompletableFuture<McpHttpServer.Response> future : held) {
                future.complete(new McpHttpServer.Response(503, "{}"));
            }
            for (Socket socket : sockets) socket.close();
        }
    }

    private McpHttpServer start(McpHttpServer.Handler handler) throws IOException {
        McpHttpServer started = new McpHttpServer(handler, TOKEN, false);
        server = started;
        started.start(0);
        return started;
    }

    private McpHttpServer start(McpHttpServer.Handler handler, int requestDeadlineMs) throws IOException {
        McpHttpServer started = new McpHttpServer(handler, TOKEN, false, requestDeadlineMs);
        server = started;
        started.start(0);
        return started;
    }

    /** True when a worker thread is blocked parsing inside the server. */
    private static boolean awaitServerRead(long timeoutMs) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        while (System.nanoTime() < deadline) {
            for (StackTraceElement[] trace : Thread.getAllStackTraces().values()) {
                for (StackTraceElement frame : trace) {
                    if (frame.getClassName().startsWith(McpHttpServer.class.getName())
                            && (frame.getMethodName().equals("readLine")
                                    || frame.getMethodName().equals("read"))) {
                        return true;
                    }
                }
            }
            Thread.sleep(10);
        }
        return false;
    }

    private static Map<String, String> headers(String... pairs) {
        Map<String, String> map = new LinkedHashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) {
            map.put(pairs[index], pairs[index + 1]);
        }
        return map;
    }

    private static Map<String, String> authorizedHeaders(String body) {
        Map<String, String> map = headers(
                "Authorization", "Bearer " + TOKEN,
                "Content-Length", String.valueOf(bytes(body).length));
        return map;
    }

    private static Map<String, String> a2aHeaders(String body) {
        return authorizedHeaders(body);
    }

    private static byte[] bytes(String value) {
        return value == null ? new byte[0] : value.getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] http(String method, String target, Map<String, String> requestHeaders, byte[] body) {
        return httpVersion(method, target, "HTTP/1.1", requestHeaders, body);
    }

    private static byte[] httpVersion(
            String method, String target, String version, Map<String, String> requestHeaders, byte[] body) {
        StringBuilder head = new StringBuilder(256);
        head.append(method).append(' ').append(target).append(' ').append(version).append("\r\n");
        head.append("Host: 127.0.0.1\r\n");
        for (Map.Entry<String, String> header : requestHeaders.entrySet()) {
            head.append(header.getKey()).append(": ").append(header.getValue()).append("\r\n");
        }
        head.append("Connection: close\r\n\r\n");
        byte[] headBytes = head.toString().getBytes(StandardCharsets.ISO_8859_1);
        if (body == null || body.length == 0) {
            return headBytes;
        }
        byte[] request = new byte[headBytes.length + body.length];
        System.arraycopy(headBytes, 0, request, 0, headBytes.length);
        System.arraycopy(body, 0, request, headBytes.length, body.length);
        return request;
    }

    private static RawResponse exchange(int port, byte[] request) throws IOException {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 3_000);
            socket.setSoTimeout(5_000);
            OutputStream output = socket.getOutputStream();
            output.write(request);
            output.flush();
            return readResponse(socket.getInputStream());
        }
    }

    private static RawResponse readResponse(InputStream input) throws IOException {
        String statusLine = readLine(input);
        if (statusLine == null) {
            throw new IOException("Server closed the connection without a response");
        }
        String[] statusParts = statusLine.split(" ", 3);
        int status = Integer.parseInt(statusParts[1]);
        Map<String, String> responseHeaders = new LinkedHashMap<>();
        String line;
        while ((line = readLine(input)) != null && !line.isEmpty()) {
            int colon = line.indexOf(':');
            if (colon > 0) {
                responseHeaders.put(
                        line.substring(0, colon).trim().toLowerCase(java.util.Locale.ROOT),
                        line.substring(colon + 1).trim());
            }
        }
        byte[] body;
        String contentLength = responseHeaders.get("content-length");
        if (contentLength != null) {
            int length = Integer.parseInt(contentLength);
            body = readFully(input, length);
        } else {
            body = readToEnd(input);
        }
        return new RawResponse(status, responseHeaders, new String(body, StandardCharsets.UTF_8));
    }

    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream(128);
        int value;
        while ((value = input.read()) >= 0) {
            if (value == '\n') {
                byte[] bytes = line.toByteArray();
                int length = bytes.length;
                if (length > 0 && bytes[length - 1] == '\r') {
                    length--;
                }
                return new String(bytes, 0, length, StandardCharsets.ISO_8859_1);
            }
            line.write(value);
        }
        if (line.size() == 0) {
            return null;
        }
        return new String(line.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    private static byte[] readFully(InputStream input, int length) throws IOException {
        byte[] body = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = input.read(body, offset, length - offset);
            if (read < 0) {
                throw new IOException("Response body ended early");
            }
            offset += read;
        }
        return body;
    }

    private static byte[] readToEnd(InputStream input) throws IOException {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            body.write(buffer, 0, read);
        }
        return body.toByteArray();
    }

    private static final class RawResponse {

        final int status;
        final Map<String, String> headers;
        final String body;

        RawResponse(int status, Map<String, String> headers, String body) {
            this.status = status;
            this.headers = headers;
            this.body = body;
        }
    }
}
