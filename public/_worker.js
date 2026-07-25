// Advanced-mode Pages worker: intercepts EVERY request (static assets included),
// unlike functions/_middleware which sits behind asset serving. Any *.pages.dev
// host (the production alias and per-deploy <hash> preview URLs) is a side door
// around the Zero Trust Access gate that only covers the custom domain — bounce
// them all to the gated real site. Everything else is served normally.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.endsWith(".pages.dev")) {
      url.hostname = "staycoolandstaycool.com";
      return Response.redirect(url.toString(), 302);
    }
    return env.ASSETS.fetch(request);
  },
};
