package guru.linkr.ble.mcp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import guru.linkr.ble.MainActivity;

/**
 * Keeps the app process alive while the MCP server is enabled.
 *
 * <p>The server itself lives in {@link McpServerManager}; this service only
 * owns the low-importance ongoing notification and the stop action. It is
 * intentionally not a "run forever in the background" daemon: the activity
 * owns the lifecycle, so destroying the activity stops the service and closes
 * the server.
 */
public class LinkrMcpService extends Service {

    private static final String CHANNEL_ID = "linkr-mcp";
    private static final int NOTIFICATION_ID = 8712;
    private static final String ACTION_START = "guru.linkr.ble.mcp.action.START";
    private static final String ACTION_STOP = "guru.linkr.ble.mcp.action.STOP";
    private static final String EXTRA_PORT = "port";

    public static void start(Context context, int port) {
        Intent intent = new Intent(context, LinkrMcpService.class);
        intent.setAction(ACTION_START);
        intent.putExtra(EXTRA_PORT, port);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        try {
            context.stopService(new Intent(context, LinkrMcpService.class));
        } catch (RuntimeException ignored) {
            // The process may already be tearing down.
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // A sticky restart after process death: there is no server to keep alive.
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(intent.getAction())) {
            /* The notification Stop is an explicit "do not start this again":
             * persist autoStart=false before tearing the server down. */
            McpServerManager.getInstance(this).onNotificationStop();
            stopSelf();
            return START_NOT_STICKY;
        }
        int port = intent.getIntExtra(EXTRA_PORT, McpServerManager.DEFAULT_PORT);
        if (port <= 0) {
            port = McpServerManager.DEFAULT_PORT;
        }
        try {
            startForeground(NOTIFICATION_ID, buildNotification(port));
        } catch (RuntimeException error) {
            /* Android 14+ enforces the connectedDevice prerequisites (a granted
             * BLUETOOTH_CONNECT, for example) and throws here when they are
             * missing; Android 12+ can also refuse a background start. Crashing
             * the app over a settings toggle is not acceptable: report the
             * weaker guarantee, stop this service and let the socket serve the
             * activity while it lives. */
            String message = error.getMessage() == null
                    ? "The MCP server is running without a foreground service"
                    : "The MCP server is running without a foreground service: " + error.getMessage();
            McpServerManager.getInstance(this).reportServiceFailure(message);
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel =
                new NotificationChannel(CHANNEL_ID, "Linkr Bee MCP server", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Keeps the local MCP server reachable while the app is in the background.");
        channel.setShowBadge(false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(int port) {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, 0, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent stopIntent = new Intent(this, LinkrMcpService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
                this, 1, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle("Linkr Bee MCP service is running")
                .setContentText("Listening on port " + port)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .addAction(0, "Stop", stopPendingIntent)
                .build();
    }
}
