import { ActionError } from "./model.js";
import { request, json, type Fetch } from "./http.js";
import { type Manifest, validateDescriptor } from "./oci.js";
export class Registry {
  private token = "";
  constructor(
    private repository: string,
    private actor: string,
    private credential: string,
    private fetcher: Fetch,
  ) {}
  private async read(
    url: string,
    init: RequestInit & { method?: "GET" | "HEAD" },
  ): Promise<Response> {
    // Registry authentication and inspection use only idempotent GET/HEAD.
    // A transient connection failure must not discard a completed image build.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await request(this.fetcher, url, init, "registry");
        if (
          attempt === 2 ||
          ![429, 500, 502, 503, 504].includes(response.status)
        ) return response;
        await response.body?.cancel().catch(() => {});
      } catch (error) {
        if (
          attempt === 2 ||
          !(error instanceof ActionError) ||
          error.code !== "upstream_unavailable"
        ) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  private async authorize(): Promise<void> {
    const url = new URL("https://ghcr.io/token");
    url.searchParams.set("service", "ghcr.io");
    url.searchParams.set("scope", `repository:${this.repository}:pull,push`);
    const response = await this.read(
      url.href,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.actor}:${this.credential}`).toString("base64")}`,
        },
      },
    );
    if (!response.ok)
      throw new ActionError(
        "registry_auth_failed",
        "registry",
        "GHCR authentication failed",
      );
    const body = (await json(response, "registry")) as { token?: unknown };
    if (typeof body.token !== "string")
      throw new ActionError(
        "invalid_response",
        "registry",
        "GHCR returned no token",
      );
    this.token = body.token;
  }
  private async call(path: string, method: "GET" | "HEAD"): Promise<Response> {
    if (!this.token) await this.authorize();
    const call = () =>
      this.read(
        `https://ghcr.io/v2/${this.repository}/${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept:
              "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
          },
        },
      );
    let response = await call();
    if (response.status === 401) {
      await this.authorize();
      response = await call();
    }
    return response;
  }
  async exists(digest: string): Promise<boolean> {
    const response = await this.call(`blobs/${digest}`, "HEAD");
    if (response.status === 404) return false;
    if (!response.ok)
      throw new ActionError(
        "registry_head_failed",
        "push",
        "Could not classify GHCR layer",
      );
    return true;
  }
  async assertNewTag(tag: string): Promise<void> {
    const response = await this.call(`manifests/${tag}`, "HEAD");
    if (response.status === 404) return;
    if (response.ok)
      throw new ActionError(
        "tag_exists",
        "push",
        "Release tag already exists; rerun with a new attempt",
      );
    throw new ActionError(
      "registry_head_failed",
      "push",
      "Could not verify release tag absence",
    );
  }
  async manifest(digest: string, platform: string): Promise<Manifest> {
    const response = await this.call(`manifests/${digest}`, "GET");
    if (!response.ok)
      throw new ActionError(
        "image_not_found",
        "push",
        "Could not read pushed manifest",
      );
    const body = (await json(response, "push")) as Manifest & {
      manifests?: {
        digest: string;
        size: number;
        platform?: { os: string; architecture: string; variant?: string };
      }[];
    };
    if (body.manifests) {
      const [os, architecture, variant] = platform.split("/");
      const match = body.manifests.find(
        (m) =>
          m.platform?.os === os &&
          m.platform.architecture === architecture &&
          (!variant || m.platform.variant === variant),
      );
      if (!match)
        throw new ActionError(
          "platform_mismatch",
          "push",
          "Pushed image platform does not match",
        );
      validateDescriptor(match);
      return this.manifest(match.digest, platform);
    }
    if (!Array.isArray(body.layers) || !body.config)
      throw new ActionError(
        "invalid_manifest",
        "push",
        "Invalid pushed manifest",
      );
    validateDescriptor(body.config);
    body.layers.forEach(validateDescriptor);
    return body;
  }
}
