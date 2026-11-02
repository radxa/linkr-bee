package guru.linkr.ble.mcp;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor bridge for the native MCP server.
 *
 * <p>Java only authenticates and transports; the WebView answers every JSON-RPC
 * request through the {@code httpRequest} event and {@code respond} call.
 */
@CapacitorPlugin(name = "LinkrMcp")
public class LinkrMcpPlugin extends Plugin {

    private McpServerManager manager;

    @Override
    public void load() {
        manager = McpServerManager.getInstance(getContext());
        manager.attach(this);
    }

    @Override
    protected void handleOnResume() {
        if (manager != null) {
            manager.setForeground(true);
        }
    }

    @Override
    protected void handleOnPause() {
        if (manager != null) {
            manager.setForeground(false);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (manager != null) {
            manager.onActivityDestroyed();
            manager.detach(this);
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (manager == null) {
            call.reject("MCP bridge is not ready");
            return;
        }
        Integer port = call.getInt("port");
        String bind = call.getString("bind");
        try {
            manager.start(port, bind);
            call.resolve(manager.getState());
        } catch (Exception error) {
            String message = error.getMessage() == null ? "Could not start the MCP server" : error.getMessage();
            call.reject(message, error);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (manager == null) {
            call.reject("MCP bridge is not ready");
            return;
        }
        manager.stop();
        call.resolve(manager.getState());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        if (manager == null) {
            call.reject("MCP bridge is not ready");
            return;
        }
        call.resolve(manager.getState());
    }

    @PluginMethod
    public void regenerateToken(PluginCall call) {
        if (manager == null) {
            call.reject("MCP bridge is not ready");
            return;
        }
        call.resolve(manager.regenerateToken());
    }

    @PluginMethod
    public void respond(PluginCall call) {
        if (manager == null) {
            call.reject("MCP bridge is not ready");
            return;
        }
        String id = call.getString("id");
        if (id == null) {
            call.reject("Request id is required");
            return;
        }
        Integer status = call.getInt("status");
        String body = call.getString("body");
        manager.respond(id, status == null ? 200 : status, body == null ? "" : body);
        call.resolve();
    }

    /**
     * Posts an Allow/Deny notification for a write approval. Resolves with a
     * boolean (see below): {@code true} when a notification was posted,
     * {@code false} when the user disabled notifications or denied the
     * POST_NOTIFICATIONS permission. A disabled notification permission is not
     * an error, so this never rejects for it.
     */
    @PluginMethod
    public void showApproval(PluginCall call) {
        if (manager == null) {
            call.reject("MCP bridge is not ready");
            return;
        }
        String id = call.getString("id");
        if (id == null || id.trim().isEmpty()) {
            call.reject("Approval id is required");
            return;
        }
        Long deadlineMs = call.getLong("deadlineMs");
        boolean posted = manager.showApproval(
                id,
                call.getString("title"),
                call.getString("body"),
                deadlineMs == null ? 0L : deadlineMs);
        /* Capacitor's PluginCall can only resolve a JSON object, so the boolean
         * travels as {posted}; the TypeScript bridge unwraps it to a boolean. */
        JSObject result = new JSObject();
        result.put("posted", posted);
        call.resolve(result);
    }

    /**
     * Asks for POST_NOTIFICATIONS on Android 13+ so background approvals can be
     * posted later. The web layer calls this when the user enables the server (a
     * foreground moment); the OS dialog is asynchronous, so this resolves
     * immediately.
     *
     * <p>Both the permission request and the resolve run on the UI thread: the
     * Capacitor bridge may invoke a plugin method on a worker, while
     * {@code requestPermissions} must be called from an Activity on the main
     * thread. Without the permission the feature degrades to the in-app
     * approval card and background requests are refused.
     */
    @PluginMethod
    public void requestApprovalPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getActivity() == null) {
            call.resolve();
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (getActivity() != null
                    && getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                            != PackageManager.PERMISSION_GRANTED) {
                try {
                    ActivityCompat.requestPermissions(
                            getActivity(),
                            new String[] {Manifest.permission.POST_NOTIFICATIONS},
                            8712);
                } catch (RuntimeException ignored) {
                    /* The activity may be finishing; the in-app fallback remains. */
                }
            }
            call.resolve();
        });
    }

    /** Dismisses a pending approval notification. Unknown ids are a no-op. */
    @PluginMethod
    public void cancelApproval(PluginCall call) {
        if (manager == null) {
            call.reject("MCP bridge is not ready");
            return;
        }
        String id = call.getString("id");
        if (id == null || id.trim().isEmpty()) {
            call.reject("Approval id is required");
            return;
        }
        manager.cancelApproval(id);
        call.resolve();
    }

    /** True while the WebView has subscribed to forwarded HTTP requests. */
    public boolean hasHttpRequestListener() {
        return hasListeners("httpRequest");
    }

    public void emitHttpRequest(JSObject payload) {
        notifyListeners("httpRequest", payload);
    }

    public void emitRequestCancelled(JSObject payload) {
        notifyListeners("requestCancelled", payload);
    }

    public void emitStateChanged(JSObject state) {
        notifyListeners("stateChanged", state);
    }

    public void emitApprovalAction(JSObject payload) {
        notifyListeners("approvalAction", payload);
    }
}
