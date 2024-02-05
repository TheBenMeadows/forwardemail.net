/*
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const mongoose = require('mongoose');
const timezones = require('timezones-list');
const validationErrorTransform = require('mongoose-validation-error-transform');
const { isURL } = require('validator');

// <https://github.com/Automattic/mongoose/issues/5534>
mongoose.Error.messages = require('@ladjs/mongoose-error-messages');

const config = require('#config');

const {
  dummyProofModel,
  dummySchemaOptions,
  sqliteVirtualDB
} = require('#helpers/mongoose-to-sqlite');

// <https://github.com/sebbo2002/ical-generator/blob/fd502c537bf1a1e2bb5ae3579815921715fac190/src/calendar.ts#L15-L27>
const Calendars = new mongoose.Schema(
  {
    prodId: {
      type: String,
      default: '//forwardemail.net//caldav//EN'
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    description: String,
    timezone: {
      type: String,
      required: true,
      // TODO: add `Etc/UTC` timezone to this list
      enum: timezones.default.map((tz) => tz.tzCode)
    },
    source: String,
    url: {
      type: String,
      validator: (v) => isURL(v, { require_tld: false })
    },
    scale: String,
    ttl: Number,

    //
    // NOTE: `events` are stored individually in `CalendarEvents`
    //       model with a foreign key reference to this `Calendar`
    //
    // events: mongoose.Schema.Types.Mixed,
    //

    // TODO: console.log these at some point
    // `X-` meta arbitrary properties
    x: mongoose.Schema.Types.Mixed,

    //
    // NOTE: color is not currently supported (namely due to lack of client implementation)
    //       (but we could implement a workaround if we ever need this)
    //
    // <https://github.com/sebbo2002/ical-generator/issues/516>
    // <https://github.com/sebbo2002/ical-generator/issues/153>
    //
    // const validateColor = require('validate-color');
    //
    // color: {
    //   type: String,
    //   required: true,
    //   trim: true,
    //   default: '#0066ff',
    //   validate: (color) =>
    //     typeof color === 'string' && validateColor.default(color)
    // },
    //
    // similarly we have not yet implemented `order` either
    //
    // order: {
    //   type: Number,
    //   required: true,
    //   default: 0
    // },
    //

    //
    // NOTE: `readonly` and `synctoken` are arbitary non-VCALENDAR props for our implementation
    //
    readonly: {
      type: Boolean,
      required: true,
      default: false
    },
    synctoken: {
      type: String,
      required: true,
      lowercase: true,
      validate: (v) => isURL(v, { require_tld: config.env !== 'production' })
    }
  },
  dummySchemaOptions
);

Calendars.plugin(sqliteVirtualDB);
Calendars.plugin(validationErrorTransform);

module.exports = dummyProofModel(mongoose.model('Calendars', Calendars));
