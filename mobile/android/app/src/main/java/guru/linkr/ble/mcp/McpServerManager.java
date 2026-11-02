package guru.linkr.ble.mcp;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import guru.linkr.ble.R;
import android.content.pm.PackageManager;
import android.os.Build;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import guru.linkr.ble.MainActivity;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Owns the MCP server lifecycle: persisted configuration and bearer token, the
 * running {@link McpHttpServer}, forwarded requests waiting on the WebView, and
 * the state object shared with the UI.
 *
 * <p>This class is the only place that touches Android storage; the transport
 * itself stays platform-free.
 */
public final class McpServerManager {

    private static final String PREFS_NAME = "linkr_mcp";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_PORT = "port";
    private static final String KEY_BIND = "bind";
    /** False after the user taps Stop on the foreground-service notification. */
    private static final String KEY_AUTO_START = "autoStart";

    public static final int DEFAULT_PORT = 8712;
    public static final String BIND_LOOPBACK = "loopback";
    public static final String BIND_LAN = "lan";

    private static final int MIN_PORT = 1024;
    private static final int MAX_PORT = 65535;
    private static final long RESPONSE_TIMEOUT_MS = 180_000L;
    private static final int TOKEN_BYTES = 32;

    public static final String TIMEOUT_BODY =
            "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32000,\"message\":\"Linkr Bee app did not answer in time\"}}";

    /** HIGH-importance channel used only for write-approval notifications. */
    public static final String APPROVAL_CHANNEL_ID = "linkr-mcp-approval";
    /** Explicit action carried by the Allow/Deny broadcast. */
    public static final String APPROVAL_ACTION = "guru.linkr.ble.mcp.action.APPROVAL";
    public static final String EXTRA_APPROVAL_ID = "guru.linkr.ble.mcp.extra.APPROVAL_ID";
    public static final String EXTRA_APPROVAL_APPROVED = "guru.linkr.ble.mcp.extra.APPROVAL_APPROVED";
    public static final String EXTRA_APPROVAL_EXPIRED = "guru.linkr.ble.mcp.extra.APPROVAL_EXPIRED";

    private static final String APPROVAL_CHANNEL_NAME = "Linkr Bee MCP approvals";
    private static final String DEFAULT_APPROVAL_TITLE = "Linkr Bee MCP approval";
    /* Notification ids are deterministic (10000-10999) so the plugin can cancel
     * the exact notification it posted from the JS side. */
    private static final int APPROVAL_NOTIFICATION_ID_BASE = 10_000;
    private static final int APPROVAL_NOTIFICATION_ID_COUNT = 1_000;
    /**
     * Extra slack after the WebView's own approval deadline before the native
     * notification is expired. It covers a renderer that is still delivering the
     * answer while its timers are frozen.
     */
    private static final long APPROVAL_DEADLINE_GRACE_MS = 2_000L;

    private static final McpServerManager INSTANCE = new McpServerManager();

    public static McpServerManager getInstance(Context context) {
        INSTANCE.ensureContext(context);
        return INSTANCE;
    }

    private final Object lock = new Object();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();
    /** Notification ids currently posted for write approvals. */
    private final Set<Integer> approvalNotificationIds = ConcurrentHashMap.newKeySet();
    /** Expiry timers for posted approval notifications, keyed by approval id. */
    private final ConcurrentHashMap<String, ApprovalDeadline> approvalDeadlines = new ConcurrentHashMap<>();
    private final AtomicLong approvalTokenSequence = new AtomicLong();
    private final SecureRandom random = new SecureRandom();
    private final ScheduledExecutorService scheduler;

    private Context appContext;
    private SharedPreferences prefs;
    private LinkrMcpPlugin plugin;
    private McpHttpServer server;
    private String token;
    private int port = DEFAULT_PORT;
    private String bind = BIND_LAN;
    private boolean foreground;
    private boolean autoStart = true;
    /**
     * Incremented by every start/stop attempt. A forwarded request captured under
     * an older epoch must never reach the WebView, and a bind that completes
     * after a stop must be discarded instead of resurrecting the server.
     */
    private long epoch;
    private volatile String lastError;

    private McpServerManager() {
        scheduler = Executors.newSingleThreadScheduledExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable runnable) {
                Thread thread = new Thread(runnable, "linkr-mcp-timeout");
                thread.setDaemon(true);
                return thread;
            }
        });
    }

    private void ensureContext(Context context) {
        if (context == null) {
            return;
        }
        Context application = context.getApplicationContext();
        if (application == null) {
            application = context;
        }
        synchronized (lock) {
            if (prefs != null) {
                return;
            }
            appContext = application;
            prefs = application.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            token = prefs.getString(KEY_TOKEN, null);
            port = prefs.getInt(KEY_PORT, DEFAULT_PORT);
            bind = prefs.getString(KEY_BIND, BIND_LAN);
            autoStart = prefs.getBoolean(KEY_AUTO_START, true);
            if (token == null || !token.matches("[0-9a-f]{64}")) {
                token = newToken();
                prefs.edit().putString(KEY_TOKEN, token).commit();
            }
            if (!BIND_LOOPBACK.equals(bind) && !BIND_LAN.equals(bind)) {
                bind = BIND_LAN;
            }
            if (port != 0 && (port < MIN_PORT || port > MAX_PORT)) {
                port = DEFAULT_PORT;
            }
        }
    }

    public void attach(LinkrMcpPlugin plugin) {
        synchronized (lock) {
            this.plugin = plugin;
        }
        emitStateChanged();
    }

    public void detach(LinkrMcpPlugin plugin) {
        synchronized (lock) {
            if (this.plugin == plugin) {
                this.plugin = null;
            }
        }
        failAllPending(503, McpHttpServer.NOT_READY_BODY);
        /* Nobody can answer a notification approval while the bridge is gone,
         * so dismiss any outstanding ones instead of leaving stale prompts. */
        cancelAllApprovals();
    }

    public void setForeground(boolean foreground) {
        boolean changed;
        synchronized (lock) {
            changed = this.foreground != foreground;
            this.foreground = foreground;
        }
        if (changed) {
            emitStateChanged();
        }
    }

    /** Stops the server and the foreground service when the activity is destroyed. */
    public void onActivityDestroyed() {
        synchronized (lock) {
            foreground = false;
        }
        stop();
    }

    /**
     * Starts (or restarts) the server. The port may be 0 for an ephemeral bind;
     * otherwise it must be 1024–65535. A null port/bind falls back to the
     * persisted configuration.
     *
     * <p>Start and stop may race (for example a WebView-triggered start whose bind
     * overlaps the user tapping Stop): the epoch captured here is re-checked
     * after the bind, so a stop is never lost by publishing a server afterwards.
     */
    public void start(Integer requestedPort, String requestedBind) throws IOException {
        ensureContext(appContext);
        int configuredPort;
        String configuredBind;
        long startEpoch;
        McpHttpServer previous;
        synchronized (lock) {
            configuredPort = requestedPort == null ? port : requestedPort;
            configuredBind = requestedBind == null ? bind : requestedBind;
            if (configuredPort != 0 && (configuredPort < MIN_PORT || configuredPort > MAX_PORT)) {
                throw new IllegalArgumentException("Port must be 0 or between 1024 and 65535");
            }
            if (!BIND_LOOPBACK.equals(configuredBind) && !BIND_LAN.equals(configuredBind)) {
                throw new IllegalArgumentException("Bind must be \"loopback\" or \"lan\"");
            }
            /* An explicit enable re-arms auto-start after a notification Stop. */
            startEpoch = ++epoch;
            autoStart = true;
            if (prefs != null) {
                prefs.edit().putBoolean(KEY_AUTO_START, true).apply();
            }
            previous = server;
            server = null;
        }
        if (previous != null) {
            // Release the old socket before binding the new configuration so a
            // restart on the same port cannot collide with ourselves.
            previous.stop();
        }
        failAllPending(503, McpHttpServer.NOT_READY_BODY);

        McpHttpServer next = new McpHttpServer(request -> handleRequest(request, startEpoch), getToken(), BIND_LAN.equals(configuredBind));
        try {
            next.start(configuredPort);
        } catch (IOException error) {
            boolean cancelled;
            synchronized (lock) {
                cancelled = epoch != startEpoch;
                if (!cancelled) {
                    lastError = error.getMessage() == null ? "Could not start the MCP server" : error.getMessage();
                    if (prefs != null) {
                        prefs.edit().putInt(KEY_PORT, configuredPort).putString(KEY_BIND, configuredBind).apply();
                    }
                    port = configuredPort;
                    bind = configuredBind;
                }
            }
            if (cancelled) {
                /* A stop raced the bind; it already emitted its own state. Do not
                 * resurrect lastError on the stopped card. */
                Context cancelledContext = appContext;
                if (cancelledContext != null) {
                    LinkrMcpService.stop(cancelledContext);
                }
                return;
            }
            /* A restart can fail after the old listener was closed (for example
             * when the user picks a busy port). The foreground service from the
             * previous start would otherwise keep claiming the server is
             * listening, so tear it down with the socket. */
            Context context = appContext;
            if (context != null) {
                LinkrMcpService.stop(context);
            }
            emitStateChanged();
            throw error;
        }

        boolean published;
        synchronized (lock) {
            published = epoch == startEpoch;
            if (published) {
                server = next;
                port = configuredPort;
                bind = configuredBind;
                lastError = null;
                if (prefs != null) {
                    prefs.edit().putInt(KEY_PORT, configuredPort).putString(KEY_BIND, configuredBind).apply();
                }
            }
        }
        if (!published) {
            /* A stop raced with the bind: discard the new socket and do not
             * resurrect the server or its foreground service. */
            next.stop();
            emitStateChanged();
            return;
        }
        Context context;
        synchronized (lock) {
            context = epoch == startEpoch ? appContext : null;
        }
        if (context != null) {
            try {
                LinkrMcpService.start(context, next.getPort());
            } catch (RuntimeException error) {
                /* Android 12+ can refuse a foreground-service start when the app
                 * is not in a foreground state. The socket is already bound, so
                 * keep the server usable for the current session and surface the
                 * weaker lifecycle guarantee instead of failing the start. */
                synchronized (lock) {
                    if (epoch == startEpoch) {
                        lastError = error.getMessage() == null
                                ? "The MCP server is running without a foreground service"
                                : "The MCP server is running without a foreground service: " + error.getMessage();
                    }
                }
            }
            boolean stoppedMeanwhile;
            synchronized (lock) {
                stoppedMeanwhile = epoch != startEpoch;
            }
            if (stoppedMeanwhile) {
                LinkrMcpService.stop(context);
            }
        }
        emitStateChanged();
    }

    public void stop() {
        McpHttpServer current;
        synchronized (lock) {
            epoch++;
            current = server;
            server = null;
            /* A stopped card must not keep an error from an earlier start. */
            lastError = null;
        }
        if (current != null) {
            current.stop();
        }
        failAllPending(503, McpHttpServer.NOT_READY_BODY);
        /* A stopped server cannot forward approvals to the WebView any more. */
        cancelAllApprovals();
        Context context = appContext;
        if (context != null) {
            LinkrMcpService.stop(context);
        }
        emitStateChanged();
    }

    /**
     * Handles the "Stop" action on the foreground-service notification: the
     * user's explicit choice must survive a process restart, so auto-start is
     * persisted as disabled before the server is stopped.
     */
    public void onNotificationStop() {
        synchronized (lock) {
            autoStart = false;
            if (prefs != null) {
                prefs.edit().putBoolean(KEY_AUTO_START, false).commit();
            }
        }
        stop();
    }

    public JSObject regenerateToken() {
        String rotated = newToken();
        McpHttpServer current;
        synchronized (lock) {
            token = rotated;
            if (prefs != null) {
                /* Rotation must survive an abrupt death: an old token that comes
                 * back would resurrect a credential the user just revoked. */
                prefs.edit().putString(KEY_TOKEN, rotated).commit();
            }
            current = server;
        }
        if (current != null) {
            current.setToken(rotated);
        }
        failAllPending(503, McpHttpServer.NOT_READY_BODY);
        cancelAllApprovals();
        emitStateChanged();
        return getState();
    }

    public JSObject getState() {
        McpHttpServer current;
        String stateBind;
        String stateToken;
        boolean stateForeground;
        boolean stateAutoStart;
        String error;
        int configuredPort;
        synchronized (lock) {
            current = server;
            stateBind = bind;
            stateToken = token == null ? "" : token;
            stateForeground = foreground;
            stateAutoStart = autoStart;
            error = lastError;
            configuredPort = port;
        }
        boolean running = current != null && current.isRunning();
        int boundPort = running ? current.getPort() : configuredPort;
        List<String> urls = buildUrls(boundPort, stateBind);

        JSObject state = new JSObject();
        state.put("running", running);
        state.put("port", boundPort);
        state.put("bind", stateBind);
        state.put("token", stateToken);
        state.put("url", preferredUrl(boundPort, stateBind, urls));
        state.put("urls", new JSONArray(urls));
        state.put("foreground", stateForeground);
        state.put("autoStart", stateAutoStart);
        state.put("activeRequests", pending.size());
        state.put("lastError", error == null ? JSONObject.NULL : error);
        return state;
    }

    /**
     * Called by the transport for every authenticated POST /mcp or POST /a2a
     * body. A request captured just before a stop must not execute after it: the
     * epoch is captured with the pending entry and re-checked on the main thread.
     */
    private CompletableFuture<McpHttpServer.Response> handleRequest(McpHttpServer.Request request, long requestEpoch) {
        LinkrMcpPlugin target;
        synchronized (lock) {
            // Bind authorization to the listener that accepted the request.
            // A delayed old handler must not adopt a restarted server's epoch.
            if (epoch != requestEpoch) {
                return CompletableFuture.completedFuture(
                        new McpHttpServer.Response(503, McpHttpServer.NOT_READY_BODY));
            }
            target = plugin;
        }
        if (target == null) {
            return CompletableFuture.completedFuture(
                    new McpHttpServer.Response(503, McpHttpServer.NOT_READY_BODY));
        }

        String id = UUID.randomUUID().toString();
        long deadlineMs = System.currentTimeMillis() + RESPONSE_TIMEOUT_MS;
        CompletableFuture<McpHttpServer.Response> future = new CompletableFuture<>();
        Pending entry = new Pending(future);
        pending.put(id, entry);
        /* stop() may have run between the epoch read and the put. Fail the entry
         * instead of leaving it to the 180 s timeout: the transport is already
         * answering 503 on the stopped socket. */
        boolean epochChanged;
        synchronized (lock) {
            epochChanged = epoch != requestEpoch;
        }
        if (epochChanged) {
            pending.remove(id, entry);
            return CompletableFuture.completedFuture(
                    new McpHttpServer.Response(503, McpHttpServer.NOT_READY_BODY));
        }
        entry.timeout = scheduler.schedule(() -> {
            if (pending.remove(id, entry)) {
                future.complete(new McpHttpServer.Response(504, TIMEOUT_BODY));
                emitRequestCancelled(id);
            }
        }, RESPONSE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        future.whenComplete((response, error) -> pending.remove(id, entry));

        JSObject payload = new JSObject();
        payload.put("id", id);
        payload.put("method", request.method);
        payload.put("path", request.path);
        payload.put("body", request.body);
        payload.put("remote", request.remote);
        payload.put("userAgent", request.userAgent);
        payload.put("deadlineMs", deadlineMs);

        boolean posted = mainHandler.post(() -> {
            /* A paused main loop may run this after its native timeout/stop. */
            if (pending.get(id) != entry) return;
            LinkrMcpPlugin current;
            McpHttpServer currentServer;
            long currentEpoch;
            synchronized (lock) {
                current = plugin;
                currentServer = server;
                currentEpoch = epoch;
            }
            if (currentEpoch != requestEpoch
                    || current == null
                    || currentServer == null
                    || !currentServer.isRunning()
                    || !current.hasHttpRequestListener()) {
                if (pending.remove(id, entry)) {
                    entry.cancelTimeout();
                    future.complete(new McpHttpServer.Response(503, McpHttpServer.NOT_READY_BODY));
                }
                return;
            }
            try {
                current.emitHttpRequest(payload);
            } catch (RuntimeException error) {
                if (pending.remove(id, entry)) {
                    entry.cancelTimeout();
                    future.complete(new McpHttpServer.Response(503, McpHttpServer.NOT_READY_BODY));
                }
            }
        });
        if (!posted) {
            pending.remove(id, entry);
            entry.cancelTimeout();
            return CompletableFuture.completedFuture(
                    new McpHttpServer.Response(503, McpHttpServer.NOT_READY_BODY));
        }
        return future;
    }

    /** Completes a forwarded request. Unknown or already answered ids are ignored. */
    public void respond(String id, int status, String body) {
        if (id == null) {
            return;
        }
        Pending entry = pending.remove(id);
        if (entry == null) {
            return;
        }
        entry.cancelTimeout();
        entry.future.complete(new McpHttpServer.Response(status, body == null ? "" : body));
    }

    public void emitStateChanged() {
        mainHandler.post(() -> {
            LinkrMcpPlugin current;
            synchronized (lock) {
                current = plugin;
            }
            if (current != null) {
                current.emitStateChanged(getState());
            }
        });
    }

    private void emitRequestCancelled(String id) {
        mainHandler.post(() -> {
            LinkrMcpPlugin current;
            synchronized (lock) {
                current = plugin;
            }
            if (current != null) {
                JSObject payload = new JSObject();
                payload.put("id", id);
                current.emitRequestCancelled(payload);
            }
        });
    }

    /**
     * Notification id for an approval id: deterministic so {@link #cancelApproval}
     * can dismiss exactly the notification the plugin posted.
     */
    static int approvalNotificationId(String id) {
        return APPROVAL_NOTIFICATION_ID_BASE + Math.floorMod(id.hashCode(), APPROVAL_NOTIFICATION_ID_COUNT);
    }

    /**
     * Posts a HIGH-importance Allow/Deny notification for a write approval, so
     * the user can answer even while the WebView is backgrounded.
     *
     * <p>Both action buttons require the device to be unlocked
     * ({@code setAuthenticationRequired(true)}): an approval can send serial
     * input, so a locked phone must not be able to fire it.
     *
     * <p>The notification never outlives the approval: when {@code deadlineMs}
     * (the WebView's own approval deadline, absolute epoch millis) is supplied,
     * a native timer dismisses it and emits an {@code approvalAction} with
     * {@code expired=true} shortly after that deadline. This also covers a
     * frozen or dead renderer whose own timer will never fire.
     *
     * <p>Returns {@code false} instead of throwing when the app may not post
     * notifications: the user disabled them, POST_NOTIFICATIONS is not granted
     * on Android 13+, the approval is already expired, or the permission was
     * revoked between the check and the post. The caller falls back to its
     * background-error path in that case.
     *
     * @param id approval id generated by the WebView; also the event id
     * @param deadlineMs absolute epoch millis after which the approval expires,
     *                   or {@code <= 0} when the caller has no deadline
     */
    @SuppressLint("MissingPermission")
    public boolean showApproval(String id, String title, String body, long deadlineMs) {
        if (id == null || id.isEmpty()) {
            return false;
        }
        Context context;
        synchronized (lock) {
            context = appContext;
        }
        if (context == null || !canPostApprovals(context)) {
            return false;
        }
        if (deadlineMs > 0 && deadlineMs + APPROVAL_DEADLINE_GRACE_MS <= System.currentTimeMillis()) {
            /* The renderer is re-showing an approval that already expired; do not
             * put a stale prompt in front of the user. */
            return false;
        }
        int notificationId = approvalNotificationId(id);
        try {
            ensureApprovalChannel(context);
            String contentTitle = title == null || title.trim().isEmpty() ? DEFAULT_APPROVAL_TITLE : title;
            String contentBody = body == null ? "" : body;
            NotificationCompat.Action allow =
                    new NotificationCompat.Action.Builder(
                                    0,
                                    context.getString(R.string.mcp_approval_allow),
                                    approvalActionPendingIntent(context, notificationId, id, true))
                            .setAuthenticationRequired(true)
                            .build();
            NotificationCompat.Action deny =
                    new NotificationCompat.Action.Builder(
                                    0,
                                    context.getString(R.string.mcp_approval_deny),
                                    approvalActionPendingIntent(context, notificationId, id, false))
                            .setAuthenticationRequired(true)
                            .build();
            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, APPROVAL_CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                    .setContentTitle(contentTitle)
                    .setContentText(contentBody)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(contentBody))
                    .setContentIntent(approvalContentIntent(context, notificationId))
                    /* Tapping the notification body opens the app, so the
                     * approval surface must survive that tap. Swiping it away is
                     * an explicit deny, reported through the delete intent. */
                    .setAutoCancel(false)
                    .setDeleteIntent(approvalDeletePendingIntent(context, notificationId, id))
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setOnlyAlertOnce(false)
                    .addAction(allow)
                    .addAction(deny);
            NotificationManagerCompat.from(context).notify(notificationId, builder.build());
        } catch (SecurityException error) {
            /* POST_NOTIFICATIONS can be revoked while the app is running. */
            return false;
        }
        approvalNotificationIds.add(notificationId);
        scheduleApprovalDeadline(id, deadlineMs);
        return true;
    }

    /** Dismisses the notification for one approval id. Idempotent. */
    public void cancelApproval(String id) {
        if (id == null || id.isEmpty()) {
            return;
        }
        cancelApprovalDeadline(id);
        int notificationId = approvalNotificationId(id);
        approvalNotificationIds.remove(notificationId);
        Context context;
        synchronized (lock) {
            context = appContext;
        }
        if (context != null) {
            NotificationManagerCompat.from(context).cancel(notificationId);
        }
    }

    /** Dismisses every outstanding approval notification. Idempotent. */
    public void cancelAllApprovals() {
        for (String id : new ArrayList<>(approvalDeadlines.keySet())) {
            cancelApprovalDeadline(id);
        }
        if (approvalNotificationIds.isEmpty()) {
            return;
        }
        Context context;
        synchronized (lock) {
            context = appContext;
        }
        for (Integer notificationId : new ArrayList<>(approvalNotificationIds)) {
            approvalNotificationIds.remove(notificationId);
            if (notificationId != null && context != null) {
                NotificationManagerCompat.from(context).cancel(notificationId);
            }
        }
    }

    /** Schedules the native expiry timer for a posted approval notification. */
    private void scheduleApprovalDeadline(String id, long deadlineMs) {
        cancelApprovalDeadline(id);
        if (deadlineMs <= 0) {
            return;
        }
        long delayMs = Math.max(0L, deadlineMs + APPROVAL_DEADLINE_GRACE_MS - System.currentTimeMillis());
        long token = approvalTokenSequence.incrementAndGet();
        ApprovalDeadline deadline = new ApprovalDeadline(token);
        ApprovalDeadline previous = approvalDeadlines.put(id, deadline);
        if (previous != null) previous.cancel();
        // Register before scheduling: an already-expired timer can run at once.
        ScheduledFuture<?> future = scheduler.schedule(() -> {
            ApprovalDeadline current = approvalDeadlines.get(id);
            if (current == null || current.token != token || !approvalDeadlines.remove(id, current)) {
                /* A newer show/cancel replaced this timer. */
                return;
            }
            /* Dismiss the notification first, then report the denial so the
             * WebView and the transport both see the request end. */
            cancelApprovalNotification(id);
            onApprovalAction(id, false, true);
        }, delayMs, TimeUnit.MILLISECONDS);
        deadline.setFuture(future);
    }

    private void cancelApprovalDeadline(String id) {
        ApprovalDeadline deadline = approvalDeadlines.remove(id);
        if (deadline != null) {
            deadline.cancel();
        }
    }

    /** Cancels the notification only; the expiry timer is managed by the caller. */
    private void cancelApprovalNotification(String id) {
        int notificationId = approvalNotificationId(id);
        approvalNotificationIds.remove(notificationId);
        Context context;
        synchronized (lock) {
            context = appContext;
        }
        if (context != null) {
            NotificationManagerCompat.from(context).cancel(notificationId);
        }
    }

    /**
     * Handles an Allow/Deny tap from {@link LinkrMcpApprovalReceiver}, a dismiss
     * (reported as a deny) or a native deadline expiry: dismisses the
     * notification and forwards the decision to the WebView as an
     * {@code approvalAction} event on the main thread. When no plugin is
     * attached the decision is dropped (there is no page to answer).
     */
    public void onApprovalAction(String id, boolean approved) {
        onApprovalAction(id, approved, false);
    }

    public void onApprovalAction(String id, boolean approved, boolean expired) {
        if (id == null || id.isEmpty()) {
            return;
        }
        boolean attached;
        synchronized (lock) {
            attached = plugin != null;
        }
        if (!attached) {
            cancelApproval(id);
            return;
        }
        boolean posted = mainHandler.post(() -> {
            LinkrMcpPlugin current;
            synchronized (lock) {
                current = plugin;
            }
            if (current == null) {
                cancelApproval(id);
                return;
            }
            JSObject payload = new JSObject();
            payload.put("id", id);
            payload.put("approved", approved);
            if (expired) {
                payload.put("expired", true);
            }
            try {
                current.emitApprovalAction(payload);
            } catch (RuntimeException ignored) {
                /* A destroyed WebView must not crash the receiver. */
            }
            cancelApproval(id);
        });
        if (!posted) {
            cancelApproval(id);
        }
    }

    private boolean canPostApprovals(Context context) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    private void ensureApprovalChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(APPROVAL_CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                APPROVAL_CHANNEL_ID, APPROVAL_CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Approval requests for writes from external MCP clients.");
        channel.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(channel);
    }

    private PendingIntent approvalActionPendingIntent(
            Context context, int notificationId, String id, boolean approved) {
        Intent intent = new Intent(context, LinkrMcpApprovalReceiver.class);
        intent.setAction(APPROVAL_ACTION);
        intent.setData(new Uri.Builder().scheme("linkr-mcp").authority("approval")
                .appendPath(id).appendPath(approved ? "allow" : "deny").build());
        intent.putExtra(EXTRA_APPROVAL_ID, id);
        intent.putExtra(EXTRA_APPROVAL_APPROVED, approved);
        /* Distinct request codes keep Allow and Deny from overwriting each
         * other in the PendingIntent cache. */
        int requestCode = approved ? notificationId * 2 : notificationId * 2 + 1;
        return PendingIntent.getBroadcast(context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * A dismissed notification is an explicit deny: the user removed the only
     * approval surface, so the pending write must not stay open.
     */
    private PendingIntent approvalDeletePendingIntent(Context context, int notificationId, String id) {
        Intent intent = new Intent(context, LinkrMcpApprovalReceiver.class);
        intent.setAction(APPROVAL_ACTION);
        intent.setData(new Uri.Builder().scheme("linkr-mcp").authority("approval")
                .appendPath(id).appendPath("dismiss").build());
        intent.putExtra(EXTRA_APPROVAL_ID, id);
        intent.putExtra(EXTRA_APPROVAL_APPROVED, false);
        intent.putExtra(EXTRA_APPROVAL_EXPIRED, false);
        // The data URI distinguishes dismissal from every Allow/Deny intent,
        // even when notification hashes or request codes collide.
        return PendingIntent.getBroadcast(context, notificationId * 2 + 2, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent approvalContentIntent(Context context, int notificationId) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, notificationId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Called by {@link LinkrMcpService} when Android refuses to promote it to a
     * foreground service (a missing runtime permission or a background start).
     * The listener keeps running while the activity lives, so the failure is
     * reported as a weaker lifecycle guarantee instead of crashing the app on a
     * settings toggle.
     */
    public void reportServiceFailure(String message) {
        synchronized (lock) {
            lastError = message == null || message.isEmpty()
                    ? "The MCP server is running without a foreground service"
                    : message;
        }
        emitStateChanged();
    }

    private void failAllPending(int status, String body) {
        for (String id : new ArrayList<>(pending.keySet())) {
            Pending entry = pending.remove(id);
            if (entry != null) {
                entry.cancelTimeout();
                entry.future.complete(new McpHttpServer.Response(status, body));
                emitRequestCancelled(id);
            }
        }
    }

    private String getToken() {
        synchronized (lock) {
            if (token == null || token.isEmpty()) {
                token = newToken();
                if (prefs != null) {
                    prefs.edit().putString(KEY_TOKEN, token).commit();
                }
            }
            return token;
        }
    }

    private String newToken() {
        byte[] bytes = new byte[TOKEN_BYTES];
        random.nextBytes(bytes);
        StringBuilder hex = new StringBuilder(TOKEN_BYTES * 2);
        for (byte value : bytes) {
            hex.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return hex.toString();
    }

    private List<String> buildUrls(int boundPort, String stateBind) {
        Set<String> loopback = new LinkedHashSet<>();
        loopback.add("http://127.0.0.1:" + boundPort + "/mcp");
        if (BIND_LOOPBACK.equals(stateBind)) {
            return new ArrayList<>(loopback);
        }
        Set<String> urls = new LinkedHashSet<>(loopback);
        for (String address : lanAddresses()) {
            urls.add("http://" + address + ":" + boundPort + "/mcp");
        }
        return new ArrayList<>(urls);
    }

    private String preferredUrl(int boundPort, String stateBind, List<String> urls) {
        if (!BIND_LOOPBACK.equals(stateBind)) {
            for (String url : urls) {
                if (!url.contains("127.0.0.1")) {
                    return url;
                }
            }
        }
        return urls.isEmpty() ? "" : urls.get(0);
    }

    /**
     * Candidate base URLs, best first: an interface Android most likely routes
     * LAN traffic over (Wi-Fi, Ethernet, hotspot) before any other, and IPv4
     * before IPv6. Cellular and VPN interfaces are excluded: they are up and
     * look like ordinary interfaces to {@link NetworkInterface}, but a client on
     * the same Wi-Fi network cannot reach a carrier NAT or tunnel address.
     */
    private List<String> lanAddresses() {
        List<AddressCandidate> candidates = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface network = interfaces.nextElement();
                if (!network.isUp() || network.isLoopback() || network.isVirtual()) {
                    continue;
                }
                String name = network.getName() == null ? "" : network.getName().toLowerCase(Locale.ROOT);
                int interfaceRank = interfaceRank(name);
                if (interfaceRank < 0) {
                    continue;
                }
                Enumeration<InetAddress> inetAddresses = network.getInetAddresses();
                while (inetAddresses.hasMoreElements()) {
                    InetAddress address = inetAddresses.nextElement();
                    if (address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isMulticastAddress()) {
                        continue;
                    }
                    boolean ipv4 = address instanceof Inet4Address;
                    String host = ipv4 ? address.getHostAddress() : "[" + address.getHostAddress() + "]";
                    candidates.add(new AddressCandidate(host, interfaceRank * 10 + (ipv4 ? 1 : 0)));
                }
            }
        } catch (SocketException ignored) {
            // No usable interface: loopback stays the only address.
        }
        candidates.sort((left, right) -> Integer.compare(right.score, left.score));
        List<String> addresses = new ArrayList<>();
        for (AddressCandidate candidate : candidates) {
            addresses.add(candidate.host);
        }
        return addresses;
    }

    /** 2 for a LAN-grade interface, 1 for another usable one, -1 to exclude it. */
    private static int interfaceRank(String name) {
        if (name.isEmpty()) {
            return 1;
        }
        if (name.startsWith("rmnet") || name.startsWith("ccmni") || name.startsWith("pdp")
                || name.startsWith("tun") || name.startsWith("tap") || name.startsWith("ppp")
                || name.startsWith("dummy") || name.startsWith("sit") || name.startsWith("ip6tnl")) {
            return -1;
        }
        if (name.startsWith("wlan") || name.startsWith("wifi") || name.startsWith("eth")
                || name.startsWith("ap") || name.startsWith("rndis") || name.startsWith("usb")) {
            return 2;
        }
        return 1;
    }

    private static final class AddressCandidate {

        final String host;
        final int score;

        AddressCandidate(String host, int score) {
            this.host = host;
            this.score = score;
        }
    }

    private static final class Pending {

        final CompletableFuture<McpHttpServer.Response> future;
        volatile ScheduledFuture<?> timeout;

        Pending(CompletableFuture<McpHttpServer.Response> future) {
            this.future = future;
        }

        void cancelTimeout() {
            ScheduledFuture<?> scheduled = timeout;
            if (scheduled != null) {
                scheduled.cancel(false);
            }
        }
    }

    /**
     * One scheduled expiry for a posted approval notification. The token lets a
     * re-shown approval supersede an older timer for the same id.
     */
    static final class ApprovalDeadline {

        final long token;
        private ScheduledFuture<?> future;
        private boolean cancelled;

        ApprovalDeadline(long token) {
            this.token = token;
        }

        synchronized void setFuture(ScheduledFuture<?> future) {
            this.future = future;
            if (cancelled) future.cancel(false);
        }

        synchronized void cancel() {
            cancelled = true;
            if (future != null) future.cancel(false);
        }
    }
}
