import { XrpcErrors } from '../middleware/XrpcErrorMapper.js';
import type { AtSessionService } from '../../auth/AtSessionTypes.js';

export class ServerRefreshSessionRoute {
  constructor(private readonly sessionService: AtSessionService) {}

  async handle(
    authorizationHeader: string | undefined
  ): Promise<{ headers: Record<string, string>; body: unknown }> {
    if (!authorizationHeader?.startsWith('Bearer ')) {
      throw XrpcErrors.authRequired('Refresh token is required');
    }

    const refreshJwt = authorizationHeader.slice('Bearer '.length).trim();
    if (!refreshJwt) {
      throw XrpcErrors.authRequired('Refresh token is required');
    }

    const result = await this.sessionService.refreshSession(refreshJwt);

    return {
      headers: { 'Content-Type': 'application/json' },
      body: result,
    };
  }
}
