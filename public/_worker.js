// Advanced-mode Pages worker. The Zero Trust Access gate only covers the custom
// domain; the Pages project is also served at staycool-site.pages.dev and at
// per-deploy <hash>.pages.dev preview URLs with NO gate. Nobody should be using
// those, so hard-block them (404 — as if nothing is there). The real, gated site
// at staycoolandstaycool.com serves normally.
//
// NOTE: advanced mode bypasses the automatic 404.html convention. Pages falls
// back to index.html with a 404 status, so a mistyped URL showed the home page
// under a not-found code. Serve the real 404 page explicitly.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.endsWith(".pages.dev")) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;

    const notFound = await env.ASSETS.fetch(new URL("/404.html", url));
    return new Response(notFound.body, {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};
