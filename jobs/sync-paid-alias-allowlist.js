const { isIP } = require('node:net');

// eslint-disable-next-line import/no-unassigned-import
require('#config/env');
// eslint-disable-next-line import/no-unassigned-import
require('#config/mongoose');

const process = require('process');
const { parentPort } = require('worker_threads');

const Graceful = require('@ladjs/graceful');
const Redis = require('@ladjs/redis');
const isFQDN = require('is-fqdn');
const mongoose = require('mongoose');
const ms = require('ms');
const parseErr = require('parse-err');
const safeStringify = require('fast-safe-stringify');
const sharedConfig = require('@ladjs/shared-config');
const { boolean } = require('boolean');
const { isEmail } = require('validator');

const Aliases = require('#models/aliases');
const Domains = require('#models/domains');
const Users = require('#models/users');
const config = require('#config');
const createTangerine = require('#helpers/create-tangerine');
const emailHelper = require('#helpers/email');
const logger = require('#helpers/logger');
const parseRootDomain = require('#helpers/parse-root-domain');
const setupMongoose = require('#helpers/setup-mongoose');

const breeSharedConfig = sharedConfig('BREE');
const client = new Redis(breeSharedConfig.redis, logger);
const resolver = createTangerine(client, logger);
const graceful = new Graceful({
  mongooses: [mongoose],
  redisClients: [client],
  logger
});
const SEVEN_DAYS_TO_MS = ms('7d');

graceful.listen();

// eslint-disable-next-line complexity
(async () => {
  await setupMongoose(logger);

  try {
    const [bannedUserIds, domainIds] = await Promise.all([
      Users.distinct('_id', {
        $or: [
          {
            [config.userFields.isBanned]: true
          },
          {
            [config.userFields.hasVerifiedEmail]: false
          },
          {
            [config.userFields.paymentReminderTerminationNoticeSentAt]: {
              $exists: true
            }
          }
        ]
      }),
      Domains.distinct('_id', {
        plan: { $ne: 'free' },
        has_mx_record: true,
        has_txt_record: true
      })
    ]);

    for await (const domain of Domains.find({ _id: { $in: domainIds } })
      .sort({ created_at: -1 })
      .lean()
      .cursor()) {
      logger.info('processing %s', domain.name);
      const set = new Set();
      set.add(`${domain.name}`);
      {
        // parse root domain
        const rootDomain = parseRootDomain(domain.name);
        if (domain.name !== rootDomain) set.add(rootDomain);
      }

      const aliasIds = await Aliases.distinct('_id', {
        domain: domain._id,
        is_enabled: true,
        user: {
          $nin: bannedUserIds
        }
      });
      for await (const alias of Aliases.find({ _id: { $in: aliasIds } })
        .lean()
        .cursor()) {
        logger.info(
          'alias %s@%s (%d recipients)',
          alias.name,
          domain.name,
          alias.recipients.length
        );
        for (const recipient of alias.recipients) {
          if (isFQDN(recipient)) {
            const domain = recipient.toLowerCase();
            set.add(domain);
            // parse root domain
            const rootDomain = parseRootDomain(domain);
            if (domain !== rootDomain) set.add(domain);
          } else if (isEmail(recipient)) {
            set.add(recipient); // already lowercased (see alias model)
            // parse domain
            const [, domain] = recipient.split('@');
            // parse root domain
            set.add(domain);
            // parse root domain
            const rootDomain = parseRootDomain(domain);
            if (domain !== rootDomain) set.add(domain);
          } else if (isIP(recipient)) {
            set.add(recipient);
          }
          // TODO: we don't ban webhooks currently
        }
      }

      // continue early if no results found
      if (set.size === 0) continue;

      // lookup mx records for recipient and domain
      for (const host of set) {
        if (!isFQDN(host)) continue;
        // lookup A record for the hostname
        try {
          // eslint-disable-next-line no-await-in-loop
          const ips = await resolver.resolve(host);

          for (const ip of ips) {
            if (isIP(ip)) set.add(ip);
          }
        } catch (err) {
          logger.warn(err, { domain, host });
        }

        // TODO: we should also check hostnames of the exchanges for denylist (?)
        //       (we'd need to mirror this to SMTP side if so)

        //
        // lookup the MX records for the hostname
        // and then if any are found, if they are IP's then add otherwise if FQDN then lookup A records
        //
        try {
          // eslint-disable-next-line no-await-in-loop
          const records = await resolver.resolveMx(host);
          if (records.length > 0) {
            for (const record of records) {
              if (isIP(record.exchange)) {
                set.add(record.exchange);
              } else if (isFQDN(record.exchange)) {
                // lookup the IP address of the exchange
                try {
                  // eslint-disable-next-line no-await-in-loop
                  const ips = await resolver.resolve(record.exchange);
                  for (const ip of ips) {
                    if (isIP(ip)) set.add(ip);
                  }
                } catch (err) {
                  logger.error(err, { domain, host });
                }
              }
            }
          }
        } catch (err) {
          logger.warn(err, { domain, host });
        }
      }

      if (set.size === 0) continue;

      // check backscatter (filtered for ip's only)
      {
        const filteredIPs = [...set].filter((v) => isIP(v));
        if (filteredIPs.length > 0) {
          const results = await client.mget(
            filteredIPs.map((v) => `backscatter:${v}`)
          );

          const list = [];
          for (const [i, result] of results.entries()) {
            if (boolean(result)) list.push(filteredIPs[i]);
          }

          // email admins regarding this specific domain
          if (list.length > 0)
            await emailHelper({
              template: 'alert',
              message: {
                to: config.email.message.from,
                subject: `Backscatter results detected for ${domain.name}`
              },
              locals: {
                message: `<p class="text-center">The domain ${domain.name} (${
                  domain.id
                }) had the following backscatter results:</p><ul class="mb-0 text-left"><li>${list.join(
                  '</li><li>'
                )}</li></ul>`
              }
            });
        }
      }

      if (set.size === 0) continue;

      // check denylist
      {
        const arr = [...set];
        const results = await client.mget(arr.map((v) => `denylist:${v}`));
        const list = [];
        for (const [i, result] of results.entries()) {
          if (boolean(result)) list.push(arr[i]);
        }

        // email admins regarding this specific domain
        if (list.length > 0) {
          await emailHelper({
            template: 'alert',
            message: {
              to: config.email.message.from,
              subject: `Denylist results detected for ${domain.name}`
            },
            locals: {
              message: `<p class="text-center">The domain ${domain.name} (${
                domain.id
              }) had the following denylist results:</p><ul class="mb-0 text-left"><li>${list.join(
                '</li><li>'
              )}</li></ul>`
            }
          });

          // filter out specific emails that were marked spam
          for (const v of list) {
            if (isEmail(v)) set.delete(v);
          }
        }
      }

      if (set.size === 0) continue;

      // check silent ban
      {
        const arr = [...set];
        const results = await client.mget(arr.map((v) => `silent:${v}`));
        const list = [];
        for (const [i, result] of results.entries()) {
          // NOTE: we never allowlist if on silent ban, we only alert admins
          if (boolean(result)) list.push(arr[i]);
        }

        // email admins regarding this specific domain
        if (list.length > 0) {
          await emailHelper({
            template: 'alert',
            message: {
              to: config.email.message.from,
              subject: `Silent ban results detected for ${domain.name}`
            },
            locals: {
              message: `<p class="text-center">The domain ${domain.name} (${
                domain.id
              }) had the following denylist results:</p><ul class="mb-0 text-left"><li>${list.join(
                '</li><li>'
              )}</li></ul>`
            }
          });
          for (const v of list) {
            set.delete(v);
          }
        }
      }

      if (set.size === 0) continue;

      logger.info('adding', { set: [...set], domain });

      const p = client.pipeline();
      for (const v of set) {
        p.set(`allowlist:${v}`, 'true', 'PX', SEVEN_DAYS_TO_MS);
      }

      await p.exec();
    }
  } catch (err) {
    await logger.error(err);
    await emailHelper({
      template: 'alert',
      message: {
        to: config.email.message.from,
        subject: 'Sync paid alias allowlist had an error'
      },
      locals: {
        message: `<pre><code>${safeStringify(
          parseErr(err),
          null,
          2
        )}</code></pre>`
      }
    });
  }

  if (parentPort) parentPort.postMessage('done');
  else process.exit(0);
})();
