import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { Octokit } from "octokit";

import { githubClient } from "./github_client";

import type { Env, UserProps } from "./types";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * Only this GitHub login may complete the OAuth flow. The server is single
 * user by design — an authenticated stranger is still a stranger.
 */
function assertAllowedUser(login: string, env: Env): void {
  if (login !== env.ALLOWED_GITHUB_LOGIN) {
    throw new Error(`GitHub user ${login} is not permitted to use this server.`);
  }
}

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (context) => {
  const oauthRequest = await context.env.OAUTH_PROVIDER.parseAuthRequest(
    context.req.raw,
  );
  if (!oauthRequest.clientId) {
    return context.text("Invalid authorization request.", 400);
  }

  return Response.redirect(
    buildGithubRedirect(context.env, oauthRequest, new URL(context.req.url)),
    302,
  );
});

app.get("/callback", async (context) => {
  const code = context.req.query("code");
  const state = context.req.query("state");
  if (!code || !state) {
    return context.text("Missing code or state.", 400);
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = JSON.parse(atob(state)) as AuthRequest;
  } catch {
    return context.text("Invalid state.", 400);
  }

  const accessToken = await exchangeCodeForToken(context.env, code);
  const octokit = githubClient(accessToken);
  const user = await octokit.rest.users.getAuthenticated();
  const login = user.data.login;

  try {
    assertAllowedUser(login, context.env);
  } catch (error) {
    return context.text((error as Error).message, 403);
  }

  const props: UserProps = {
    login,
    name: user.data.name ?? login,
  };

  const { redirectTo } = await context.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: login,
    metadata: { label: props.name },
    scope: oauthRequest.scope,
    props,
  });

  return Response.redirect(redirectTo, 302);
});

function buildGithubRedirect(
  env: Env,
  oauthRequest: AuthRequest,
  requestUrl: URL,
): string {
  const redirect = new URL(GITHUB_AUTHORIZE_URL);
  redirect.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  redirect.searchParams.set(
    "redirect_uri",
    new URL("/callback", requestUrl.origin).href,
  );
  // read:user is enough to identify the caller; the server never uses the
  // caller's token to touch the repo.
  redirect.searchParams.set("scope", "read:user");
  redirect.searchParams.set("state", btoa(JSON.stringify(oauthRequest)));
  return redirect.href;
}

async function exchangeCodeForToken(env: Env, code: string): Promise<string> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    error_description?: string;
  };

  if (!payload.access_token) {
    throw new Error(
      `GitHub token exchange returned no token: ${payload.error_description ?? "unknown error"}`,
    );
  }

  return payload.access_token;
}

export { app as GitHubHandler };
