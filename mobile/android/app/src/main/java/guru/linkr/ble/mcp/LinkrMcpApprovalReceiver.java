package guru.linkr.ble.mcp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Receives Allow/Deny taps from an MCP write-approval notification.
 *
 * <p>The receiver is not exported (see AndroidManifest.xml): the only sender is
 * the app's own {@link android.app.PendingIntent#getBroadcast}. It forwards the
 * decision to {@link McpServerManager}, which dismisses the notification and
 * emits the {@code approvalAction} event to the WebView on the main thread. A
 * notification dismissal also arrives here (reported as a deny).
 */
public class LinkrMcpApprovalReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) {
            return;
        }
        String id = intent.getStringExtra(McpServerManager.EXTRA_APPROVAL_ID);
        if (id == null || id.isEmpty()) {
            return;
        }
        boolean approved = intent.getBooleanExtra(McpServerManager.EXTRA_APPROVAL_APPROVED, false);
        boolean expired = intent.getBooleanExtra(McpServerManager.EXTRA_APPROVAL_EXPIRED, false);
        McpServerManager.getInstance(context).onApprovalAction(id, approved, expired);
    }
}
