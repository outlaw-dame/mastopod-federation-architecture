'use strict';

// Included only by the local staging image. This measures broker startup,
// never account/PDS readiness or permission to activate a release.
module.exports = {
  name: 'staging-readiness',
  dependencies: ['api'],
  async started() {
    await this.broker.call('api.addRoute', { route: {
      path: '/_staging', authentication: false, authorization: false,
      aliases: { 'GET /ready': 'staging-readiness.ready' }
    } });
  },
  actions: {
    ready(ctx) {
      const ready = this.broker.started === true;
      ctx.meta.$statusCode = ready ? 200 : 503;
      ctx.meta.$responseHeaders = { 'Cache-Control': 'no-store' };
      return { brokerStarted: ready };
    }
  }
};
