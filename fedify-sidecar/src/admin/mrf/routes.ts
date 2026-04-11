import { errorToResponse } from "./utils.js";
import {
  handleCreateSimulation,
  handleGetChain,
  handleGetModule,
  handleGetRegistryItem,
  handleGetSimulation,
  handleGetMetrics,
  handleGetTraceDecisionChain,
  handleGetTraceSuggestions,
  handleGetTrace,
  handleListRegistry,
  handleListModules,
  handleListTraces,
  handlePatchChain,
  handlePatchModule,
} from "./handlers.js";
import type { MRFAdminDeps } from "./types.js";

export function registerMRFAdminRoutes(app: any, deps: MRFAdminDeps): void {
  app.get("/internal/admin/mrf/registry", async (req: Request) => {
    try {
      return await handleListRegistry(req, deps);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.get("/internal/admin/mrf/registry/:id", async (req: Request, params: { id: string }) => {
    try {
      return await handleGetRegistryItem(req, deps, params.id);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.get("/internal/admin/mrf/modules", async (req: Request) => {
    try {
      return await handleListModules(req, deps);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.get("/internal/admin/mrf/modules/:id", async (req: Request, params: { id: string }) => {
    try {
      return await handleGetModule(req, deps, params.id);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.patch("/internal/admin/mrf/modules/:id", async (req: Request, params: { id: string }) => {
    try {
      return await handlePatchModule(req, deps, params.id);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.get("/internal/admin/mrf/chain", async (req: Request) => {
    try {
      return await handleGetChain(req, deps);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.patch("/internal/admin/mrf/chain", async (req: Request) => {
    try {
      return await handlePatchChain(req, deps);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.get("/internal/admin/mrf/traces", async (req: Request) => {
    try {
      return await handleListTraces(req, deps);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.get("/internal/admin/mrf/traces/:id", async (req: Request, params: { id: string }) => {
    try {
      return await handleGetTrace(req, deps, params.id);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.get("/internal/admin/mrf/traces/:id/chain", async (req: Request, params: { id: string }) => {
    try {
      return await handleGetTraceDecisionChain(req, deps, params.id);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.get("/internal/admin/mrf/traces/:id/suggestions", async (req: Request, params: { id: string }) => {
    try {
      return await handleGetTraceSuggestions(req, deps, params.id);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.get("/internal/admin/mrf/metrics", async (req: Request) => {
    try {
      return await handleGetMetrics(req, deps);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.post("/internal/admin/mrf/simulations", async (req: Request) => {
    try {
      return await handleCreateSimulation(req, deps);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });

  app.get("/internal/admin/mrf/simulations/:id", async (req: Request, params: { id: string }) => {
    try {
      return await handleGetSimulation(req, deps, params.id);
    } catch (err) {
      return errorToResponse(err, req.headers.get("x-request-id") || undefined);
    }
  });
}
