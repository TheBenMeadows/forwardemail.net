async function keys(ctx) {
  // this is like a migration, it will automatically add token + keys if needed
  await ctx.state.user.save();
  await ctx.render('otp/keys');
}

module.exports = keys;
