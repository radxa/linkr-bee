package guru.linkr.ble.mcp;

import static org.junit.Assert.assertTrue;

import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

public class McpApprovalDeadlineTest {
    @Test
    public void cancellationBeforeTimerPublicationStillCancelsTheTimer() {
        ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1);
        try {
            McpServerManager.ApprovalDeadline deadline = new McpServerManager.ApprovalDeadline(1);
            deadline.cancel();
            ScheduledFuture<?> future = executor.schedule(() -> {
                throw new AssertionError("a retired approval must never fire");
            }, 1, TimeUnit.DAYS);
            deadline.setFuture(future);
            assertTrue(future.isCancelled());
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    public void cancellationAfterTimerPublicationCancelsTheTimer() {
        ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1);
        try {
            McpServerManager.ApprovalDeadline deadline = new McpServerManager.ApprovalDeadline(1);
            ScheduledFuture<?> future = executor.schedule(() -> {}, 1, TimeUnit.DAYS);
            deadline.setFuture(future);
            deadline.cancel();
            deadline.cancel();
            assertTrue(future.isCancelled());
        } finally {
            executor.shutdownNow();
        }
    }
}
