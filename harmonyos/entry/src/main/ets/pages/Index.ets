import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { LinkrBleHost } from '../bridge/LinkrBleHost';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private host: LinkrBleHost = new LinkrBleHost(this.controller);

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext();
    if (context) {
      this.host.setContext(
        context as common.UIAbilityContext,
        this.getUIContext(),
      );
    }
  }

  aboutToDisappear(): void {
    this.host.dispose();
  }

  build() {
    Stack() {
      Web({ src: $rawfile('index.html'), controller: this.controller })
        .width('100%')
        .height('100%')
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(true)
        .javaScriptProxy({
          object: this.host,
          name: 'linkrBleHost',
          methodList: ['postMessage'],
          controller: this.controller
        })
    }
    .width('100%')
    .height('100%')
  }
}
