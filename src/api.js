import { actionSpecSchema } from "./schemas.js";

export const RPC_METHODS = Object.freeze({
  "session.create": { params: { type: "object", required: ["desktopId"] } },
  "session.get": { params: { type: "object", required: ["sessionId"] } },
  "session.list": { params: { type: "object" } },
  "session.close": { params: { type: "object", required: ["sessionId"] } },
  "desktop.claim": { params: { type: "object", required: ["sessionId"] } },
  "desktop.release": { params: { type: "object", required: ["sessionId"] } },
  "action.enqueue": {
    params: { type: "object", required: ["sessionId", "action"], properties: { sessionId: { type: "string" }, action: actionSpecSchema } },
  },
  "action.confirm": { params: { type: "object", required: ["actionId"] } },
  "action.cancel": { params: { type: "object", required: ["actionId"] } },
  "action.get": { params: { type: "object", required: ["actionId"] } },
  "action.status": { params: { type: "object", required: ["actionId"] } },
  "action.list": { params: { type: "object" } },
  "action.lease": { params: { type: "object" } },
  "action.executeLeased": { params: { type: "object", required: ["actionId"] } },
  "action.processNext": { params: { type: "object" } },
  "action.drain": { params: { type: "object" } },
  "audit.list": { params: { type: "object" } },
  "runtime.metrics": { params: { type: "object" } },
});

export function createRpcHandler(controlPlane) {
  return async function handle(method, params = {}) {
    switch (method) {
      case "session.create": return controlPlane.createSession(params);
      case "session.get": return controlPlane.getSession(params.sessionId);
      case "session.list": return controlPlane.listSessions();
      case "session.close": return controlPlane.closeSession(params.sessionId);
      case "desktop.claim": return controlPlane.claimDesktop(params.sessionId);
      case "desktop.release": return controlPlane.releaseDesktop(params.sessionId);
      case "action.enqueue": return controlPlane.enqueueAction(params.sessionId, params.action);
      case "action.confirm": return controlPlane.confirmAction(params.actionId, { approvedBy: params.approvedBy });
      case "action.cancel": return controlPlane.cancelAction(params.actionId, params.reason);
      case "action.get": return controlPlane.getAction(params.actionId);
      case "action.status": return controlPlane.getActionStatus(params.actionId);
      case "action.list": return controlPlane.listActions(params);
      case "action.lease": return controlPlane.leaseNext(params);
      case "action.executeLeased": return controlPlane.executeLeased(params.actionId, { workerId: params.workerId });
      case "action.processNext": return controlPlane.processNext(params);
      case "action.drain": return controlPlane.drain(params);
      case "audit.list": return controlPlane.getAuditLog(params);
      case "runtime.metrics": return controlPlane.getMetrics();
      default: {
        const error = new Error(`Unknown RPC method '${method}'.`);
        error.code = "METHOD_NOT_FOUND";
        throw error;
      }
    }
  };
}

export function mcpToolDefinitions() {
  return Object.entries(RPC_METHODS).map(([name, definition]) => ({
    name: name.replaceAll(".", "_"),
    description: `PC control-plane RPC bridge for ${name}.`,
    inputSchema: definition.params,
    rpcMethod: name,
  }));
}
