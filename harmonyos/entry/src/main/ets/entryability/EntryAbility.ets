import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';

const DOMAIN = 0x4C42;

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, 'LinkrBee', 'EntryAbility created');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.configureImmersiveWindow(windowStage);
    windowStage.loadContent('pages/Index', (error) => {
      if (error.code) {
        hilog.error(
          DOMAIN,
          'LinkrBee',
          'Failed to load Index: %{public}s',
          JSON.stringify(error),
        );
      }
    });
  }

  private async configureImmersiveWindow(
    windowStage: window.WindowStage,
  ): Promise<void> {
    try {
      const mainWindow = windowStage.getMainWindowSync();
      await mainWindow.setWindowLayoutFullScreen(true);
      await mainWindow.setWindowSystemBarProperties({
        statusBarColor: '#00000000',
        navigationBarColor: '#00000000',
      });
    } catch (error) {
      hilog.warn(
        DOMAIN,
        'LinkrBee',
        'Failed to configure immersive system bars: %{public}s',
        JSON.stringify(error),
      );
    }
  }
}
