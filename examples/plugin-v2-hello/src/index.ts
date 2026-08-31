import type { OpenCodexPluginFactory } from "../../../sdk/plugin-v2";

export default ((sdk) => {
  const group = sdk.groups.register({
    id: "example.virtual-hello",
    name: "虚拟视图示例",
    description: "演示外部插件通过语义适配器声明界面修改。",
    order: 900,
  });
  const messageActions = sdk.adapters.compose({
    id: "adapter.example-message-actions",
    name: "示例消息操作区",
    description: "把示例声明展开为通用语义视图挂载。",
    dependencies: [sdk.adapters.semanticView.ref],
    expand(declaration: {
      locator: ReturnType<typeof sdk.view.locators.css>;
      placement: typeof sdk.view.placements.append;
      content: ReturnType<typeof sdk.view.ui.text>;
    }) {
      return [sdk.adapters.semanticView.mount(declaration)];
    },
  });
  const locator = sdk.view.locators.css(
    "locator.example-message-actions",
    '[data-app-action="message-actions"]',
  );

  sdk.points.register({
    id: "example.virtual-hello.mount",
    description: "在消息操作区追加由 Provider 创建的虚拟节点",
    group,
    contributions: [messageActions.use({
      locator,
      placement: sdk.view.placements.append,
      content: sdk.view.ui.text("Hello from plugin v2"),
    })],
  });
}) satisfies OpenCodexPluginFactory;
