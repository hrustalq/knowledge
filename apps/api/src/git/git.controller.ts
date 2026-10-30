import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { Controller, ForbiddenException, Get, HttpException, Logger, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { t, withLocale } from '../i18n/t.js';
import { GitAccessService, type GitCaller } from './git-access.service.js';
import { GitRepoService } from './git-repo.service.js';

/**
 * Smart HTTP for `git clone` / `git fetch` (#636 phase 3): protocol v2 and v0,
 * served by the real `git upload-pack --stateless-rpc` over the caller's
 * repository. Push (receive-pack) is refused at its advertisement until phase 4.
 *
 * Errors are `text/plain`: git prints such a body as `remote:` lines, which
 * is how a refused key or a switched-off toggle reaches the person.
 */
@Controller()
export class GitController {
  private readonly logger = new Logger(GitController.name);

  constructor(
    private readonly access: GitAccessService,
    private readonly repos: GitRepoService,
  ) {}

  /** Liveness for the container healthcheck. */
  @Get()
  health(): string {
    return 'ok';
  }

  @Get('git/:workspaceId/:repo/info/refs')
  async refs(
    @Param('workspaceId') workspaceId: string,
    @Param('repo') repo: string,
    @Query('service') service: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.serve(req, res, workspaceId, repo, async (caller, projectId) => {
      // Push arrives in phase 4. Git asks for this advertisement before any pack, so refusing it here is enough.
      if (service === 'git-receive-pack') throw new ForbiddenException(t('error.git.pushUnavailable'));
      if (service !== 'git-upload-pack') {
        // Dumb HTTP is not served: every git since 1.6.6 asks for a service.
        res.status(403).type('text/plain').send(`${t('error.git.smartHttpOnly')}\n`);
        return;
      }
      const dir = await this.repos.repoFor(workspaceId, projectId, caller.scope, true);
      const v2 = /version=2/.test(String(req.headers['git-protocol'] ?? ''));
      res.setHeader('Content-Type', 'application/x-git-upload-pack-advertisement');
      res.setHeader('Cache-Control', 'no-cache');
      // v0 opens with the service line; v2's capability advertisement does not.
      if (!v2) res.write('001e# service=git-upload-pack\n0000');
      await this.uploadPack(req, res, dir, v2, true);
    });
  }

  @Post('git/:workspaceId/:repo/git-upload-pack')
  async pack(
    @Param('workspaceId') workspaceId: string,
    @Param('repo') repo: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.serve(req, res, workspaceId, repo, async (caller, projectId) => {
      const dir = await this.repos.repoFor(workspaceId, projectId, caller.scope, false);
      res.setHeader('Content-Type', 'application/x-git-upload-pack-result');
      res.setHeader('Cache-Control', 'no-cache');
      await this.uploadPack(req, res, dir, /version=2/.test(String(req.headers['git-protocol'] ?? '')), false);
    });
  }

  private async serve(
    req: Request,
    res: Response,
    workspaceId: string,
    repo: string,
    fn: (caller: GitCaller, projectId: string) => Promise<void>,
  ): Promise<void> {
    try {
      const caller = await this.access.authorize(req, workspaceId, repo);
      await withLocale(caller.locale, () => fn(caller, repo.replace(/\.git$/, '')));
    } catch (err) {
      if (res.headersSent) {
        this.logger.error({ msg: 'git request failed mid-response', err });
        res.end();
        return;
      }
      if (!(err instanceof HttpException)) {
        this.logger.error({ msg: 'git request failed', err });
        res.status(500).type('text/plain').send('Internal error.\n');
        return;
      }
      const body = err.getResponse();
      const message = typeof body === 'string' ? body : String((body as { message?: unknown }).message ?? err.message);
      if (err.getStatus() === 401) res.setHeader('WWW-Authenticate', 'Basic realm="knowledge", charset="UTF-8"');
      if (err.getStatus() === 429) res.setHeader('Retry-After', '60');
      res.status(err.getStatus()).type('text/plain').send(`${message}\n`);
    }
  }

  /** Pipe the request (gunzipped when git compressed it) through `git upload-pack`. */
  private uploadPack(req: Request, res: Response, dir: string, v2: boolean, advertise: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['upload-pack', '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), dir], {
        env: { ...process.env, ...(v2 ? { GIT_PROTOCOL: 'version=2' } : {}) },
      });
      const stderr: Buffer[] = [];
      child.stderr.on('data', (c: Buffer) => stderr.push(c));
      child.on('error', reject);
      // A client that hangs up mid-request ends git's stdin early; `close` still settles.
      child.stdin.on('error', () => undefined);
      child.stdout.pipe(res);
      child.on('close', (code) => {
        if (code !== 0) this.logger.warn({ msg: 'git upload-pack exited', code, stderr: Buffer.concat(stderr).toString().trim() });
        resolve();
      });
      if (advertise) child.stdin.end();
      else {
        const body = req.headers['content-encoding'] === 'gzip' ? req.pipe(createGunzip()) : req;
        body.on('error', () => child.kill());
        body.pipe(child.stdin);
      }
    });
  }
}
