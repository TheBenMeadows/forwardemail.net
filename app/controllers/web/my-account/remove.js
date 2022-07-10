const Boom = require('@hapi/boom');
const Stripe = require('stripe');
const isSANB = require('is-string-and-not-blank');

const config = require('#config');
const emailHelper = require('#helpers/email');
const env = require('#config/env');
const i18n = require('#helpers/i18n');
const { Domains, Aliases } = require('#models');
const { paypalAgent } = require('#helpers/paypal');

const stripe = new Stripe(env.STRIPE_SECRET_KEY);

async function remove(ctx) {
  // check that we're not an admin of any domains
  const adminDomains = ctx.state.domains.filter(
    (domain) => domain.group === 'admin'
  );
  if (adminDomains.length > 0)
    return ctx.throw(
      Boom.badRequest(ctx.translateError('ACCOUNT_DELETE_HAS_DOMAINS'))
    );

  // delete aliases
  await Aliases.deleteMany({
    user: ctx.state.user._id
  });

  // TODO: handle refunds

  // cancel paypal subscription
  if (isSANB(ctx.state.user[config.userFields.paypalSubscriptionID])) {
    try {
      const agent = await paypalAgent();
      await agent.post(
        `/v1/billing/subscriptions/${
          ctx.state.user[config.userFields.paypalSubscriptionID]
        }/cancel`
      );
      ctx.state.user[config.userFields.paypalSubscriptionID] = null;
      await ctx.state.user.save();
    } catch (err) {
      ctx.logger.fatal(err);
      // email admins here
      try {
        await emailHelper({
          template: 'alert',
          message: {
            to: config.email.message.from,
            subject: `Error deleting PayPal subscription ID ${
              ctx.state.user[config.userFields.paypalSubscriptionID]
            } for ${ctx.state.user.email}`
          },
          locals: { message: err.message }
        });
      } catch (err) {
        ctx.logger.fatal(err);
      }
    }
  }

  // cancel stripe subscription
  if (isSANB(ctx.state.user[config.userFields.stripeSubscriptionID])) {
    try {
      await stripe.subscriptions.del(
        ctx.state.user[config.userFields.stripeSubscriptionID]
      );
      ctx.state.user[config.userFields.stripeSubscriptionID] = null;
      await ctx.state.user.save();
    } catch (err) {
      ctx.logger.fatal(err);
      // email admins here
      try {
        await emailHelper({
          template: 'alert',
          message: {
            to: config.email.message.from,
            subject: `Error deleting Stripe subscription ID ${
              ctx.state.user[config.userFields.stripeSubscriptionID]
            } for ${ctx.state.user.email}`
          },
          locals: { message: err.message }
        });
      } catch (err) {
        ctx.logger.fatal(err);
      }
    }
  }

  // update domains 'members.user' with this uid (pull it)
  try {
    await Domains.updateMany(
      {
        'members.user': ctx.state.user._id
      },
      {
        $pull: {
          'members.user': ctx.state.user._id
        }
      }
    );
  } catch (err) {
    ctx.logger.fatal(err);
  }

  // instead of deleting the user we'll anonymize their account
  // (this is because payment model has required user field)
  // (and we want to easily be able to populate data on churn for example)
  for (const prop of [
    config.userFields.companyName,
    config.userFields.addressLine1,
    config.userFields.addressLine2,
    config.userFields.addressCity,
    config.userFields.addressState,
    config.userFields.addressZip,
    config.userFields.companyVAT
  ]) {
    ctx.state.user[prop] = null;
  }

  ctx.state.user.email = `${ctx.state.user.id}@removed.forwardemail.net`;
  ctx.state.user[config.lastLocaleField] = i18n.getLocale();
  ctx.state.user[config.passport.fields.appleAccessToken] = null;
  ctx.state.user[config.passport.fields.appleProfileID] = null;
  ctx.state.user[config.passport.fields.appleRefreshToken] = null;
  ctx.state.user[config.passport.fields.avatarURL] = null;
  ctx.state.user[config.passport.fields.familyName] = null;
  ctx.state.user[config.passport.fields.githubAccessToken] = null;
  ctx.state.user[config.passport.fields.githubProfileID] = null;
  ctx.state.user[config.passport.fields.githubRefreshToken] = null;
  ctx.state.user[config.passport.fields.givenName] = null;
  ctx.state.user[config.passport.fields.googleAccessToken] = null;
  ctx.state.user[config.passport.fields.googleProfileID] = null;
  ctx.state.user[config.passport.fields.googleRefreshToken] = null;
  ctx.state.user[config.passport.fields.otpEnabled] = false;
  ctx.state.user[config.passport.fields.otpToken] = null;
  ctx.state.user[config.userFields.addressCountry] = 'None';
  ctx.state.user[config.userFields.apiToken] = null;
  ctx.state.user[config.userFields.changeEmailNewAddress] = '';
  ctx.state.user[config.userFields.changeEmailTokenExpiresAt] = null;
  ctx.state.user[config.userFields.changeEmailToken] = null;
  ctx.state.user[config.userFields.defaultDomain] = null;
  ctx.state.user[config.userFields.isBanned] = true;
  ctx.state.user[config.userFields.otpRecoveryKeys] = [];
  ctx.state.user[config.userFields.paypalPayerID] = null;
  ctx.state.user[config.userFields.paypalSubscriptionID] = null;
  ctx.state.user[config.userFields.stripeCustomerID] = null;
  ctx.state.user[config.userFields.stripeSubscriptionID] = null;
  ctx.state.user.save();

  if (!ctx.api)
    ctx.flash('custom', {
      title: ctx.request.t('Success'),
      text: ctx.translate('ACCOUNT_DELETE_SUCCESSFUL'),
      type: 'success',
      toast: true,
      showConfirmButton: false,
      timer: 3000,
      position: 'top'
    });
  const redirectTo = ctx.state.l('/logout');
  if (ctx.accepts('html')) ctx.redirect(redirectTo);
  else ctx.body = { redirectTo };
}

module.exports = remove;
