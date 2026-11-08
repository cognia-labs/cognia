import { defineUiModule } from "@/lib/modules/define"

// The connectors' UI layer (ADR-0250 §14). Its host layer is
// `lib/connectors/module.ts`.
export default defineUiModule({
  id: "connectors",
  effects: [
    // Turns user-meaningful inbound IM messages into Notification Center
    // records, in every window the root provider used to install it in.
    {
      name: "inbound-notification-bridge",
      load: () => import("./inbound-notification-bridge"),
    },
    // Completes connector and document-provider OAuth from `cognia://` deep
    // links (desktop and the mobile shell, cold start included).
    { name: "deep-link-router", load: () => import("./connector-deep-link-router") },
  ],
})
