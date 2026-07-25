// Advanced-mode Pages worker. The Zero Trust Access gate only covers the custom
// domain; the Pages project is also served at staycool-site.pages.dev and at
// per-deploy <hash>.pages.dev preview URLs with NO gate. Nobody should be using
// those, so hard-block them (404 — as if nothing is there). The real, gated site
// at staycoolandstaycool.com serves normally.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.endsWith(".pages.dev")) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
