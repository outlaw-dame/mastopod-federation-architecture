"use strict";

const { MoleculerError } = require("moleculer").Errors;

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  name: "internal-identity-projection",

  dependencies: ["identitybindings"],

  actions: {
    getByCanonicalAccountId: {
      params: {
        canonicalAccountId: "string|min:1",
      },
      async handler(ctx) {
        const canonicalAccountId = trimString(ctx.params.canonicalAccountId);
        return this.lookupAndNormalize(ctx, "identitybindings.getByCanonicalAccountId", {
          canonicalAccountId,
        });
      },
    },

    getByDid: {
      params: {
        atprotoDid: "string|min:1",
      },
      async handler(ctx) {
        const atprotoDid = trimString(ctx.params.atprotoDid);
        return this.lookupAndNormalize(ctx, "identitybindings.getByDid", {
          atprotoDid,
        });
      },
    },

    getByHandle: {
      params: {
        atprotoHandle: "string|min:1",
      },
      async handler(ctx) {
        const atprotoHandle = trimString(ctx.params.atprotoHandle).toLowerCase();
        return this.lookupAndNormalize(ctx, "identitybindings.getByHandle", {
          atprotoHandle,
        });
      },
    },
  },

  methods: {
    async lookupAndNormalize(ctx, actionName, params) {
      const binding = await this.lookupBinding(ctx, actionName, params);
      return this.normalize(binding);
    },

    async lookupBinding(ctx, actionName, params) {
      try {
        return await ctx.call(actionName, params);
      } catch (error) {
        if (
          error &&
          (error.code === 404 ||
            error.type === "NOT_FOUND" ||
            error.type === "IDENTITY_BINDING_NOT_FOUND")
        ) {
          return null;
        }

        throw new MoleculerError(
          "Identity projection lookup failed",
          500,
          "IDENTITY_PROJECTION_LOOKUP_FAILED",
          {
            action: actionName,
          }
        );
      }
    },

    normalize(binding) {
      if (!binding) return null;

      return {
        canonicalAccountId: binding.canonicalAccountId || null,
        webId: binding.webId || null,

        activityPubActorId: binding.activityPubActorId || binding.webId || null,
        activityPubHandle: binding.activityPubHandle || null,

        atprotoDid: binding.atprotoDid || null,
        atprotoHandle: binding.atprotoHandle || null,
        atSigningKeyRef: binding.atSigningKeyRef || null,
        atRotationKeyRef: binding.atRotationKeyRef || null,
        status: binding.status || "pending",

        repo: {
          initialized: Boolean(binding.repoInitialized),
          rootCid: binding.repoRootCid || null,
          rev: binding.repoRev || null,
        },

        createdAt: binding.createdAt || null,
        updatedAt: binding.updatedAt || null,
      };
    },
  },
};
