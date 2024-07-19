/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const getStream = require('get-stream');
const { SitemapStream } = require('sitemap');

const config = require('#config');

// in-memory caching
const cache = new Map();

// <https://developers.google.com/search/docs/specialty/international/localized-versions#sitemap>
async function sitemap(ctx) {
  if (cache.has(ctx.path)) {
    ctx.set('Content-Type', 'application/xml');
    ctx.body = cache.get(ctx.path);
    return;
  }

  const smStream = new SitemapStream({
    hostname: config.urls.web
  });

  // TODO: if you change this then also change test/web/index.js sitemap stuff
  const keys = Object.keys(config.meta).filter((key) => {
    // exclude certain pages from sitemap
    // (e.g. 401 not authorized)
    if (
      [
        '/admin',
        '/my-account',
        '/help',
        '/auth',
        '/logout',
        '/denylist',
        '/reset-password',
        config.verifyRoute,
        config.otpRoutePrefix
      ].includes(key)
    )
      return false;
    if (key.startsWith('/admin') || key.startsWith('/my-account')) return false;
    return key;
  });

  // add all the alternatives (since it would be massive translation file addition otherwise)
  for (const alternative of config.alternatives) {
    keys.push(`/blog/best-${alternative.slug}-alternative`);
    for (const a of config.alternatives) {
      if (a.name === alternative.name) continue;
      keys.push(
        `/blog/${alternative.slug}-vs-${a.slug}-email-service-comparison`
      );
    }
  }

  // for each language, iterate over each key, and write to sitemap
  for (const language of ctx.path === '/sitemap.xml'
    ? ctx.state.availableLanguages
    : [ctx.locale]) {
    // language.locale
    for (const key of keys) {
      const obj = {
        url: `/${language.locale}${key === '/' ? '' : key}`,
        links: ctx.state.availableLanguages.map((alternateLanguage) => {
          return {
            lang: alternateLanguage.locale,
            url: `/${alternateLanguage.locale}${key === '/' ? '' : key}`
          };
        })
      };
      smStream.write(obj);
    }
  }

  smStream.end();

  ctx.set('Content-Type', 'application/xml');
  const body = await getStream.buffer(smStream);
  ctx.body = body;
  cache.set(ctx.path, body);
}

module.exports = sitemap;
