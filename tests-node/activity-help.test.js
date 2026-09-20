import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activityHelp} from '../src/activity-help.js';
import {FIELDS} from '../src/config.js';

test('broker troubleshooting distinguishes data permissions, order IP checks, expired sessions and uncertain orders',()=>{
  const permission=operation=>activityHelp({kind:'order_rejected',level:'error',data:{kind:'PermissionException',operation,http_status:403}});
  assert.match(permission('cover_entry').steps.join(' '),/IP Whitelist/);
  assert.match(permission('daily_history').steps.join(' '),/subscription/);assert.doesNotMatch(permission('daily_history').steps.join(' '),/IP Whitelist/);
  const session=activityHelp({kind:'account_error',level:'error',data:{kind:'TokenException',http_status:403}});
  assert.match(session.steps.join(' '),/Start Trading/);assert.doesNotMatch(session.steps.join(' '),/IP Whitelist/);
  const unknown=activityHelp({kind:'order_unknown',level:'error',data:{kind:'NetworkException',http_status:502}});
  assert.match(unknown.steps.join(' '),/Orders and Positions/);assert.match(unknown.steps.join(' '),/does not prove/);
  const cover=activityHelp({kind:'order_rejected',level:'error',data:{kind:'PermissionException',code:'cover_unavailable'}});
  assert.match(cover.steps.join(' '),/cover-order eligibility/);assert.doesNotMatch(cover.steps.join(' '),/IP Whitelist/);
});

test('scanner summaries link common blockers to real settings and unknown errors do not echo payloads',()=>{
  const help=activityHelp({kind:'scan_summary',data:{'decision:maximum_positions':30,'decision:existing_holdings_ignored':10,'decision:invalid_capital_allocation':5}});
  assert.equal(help.steps.length,3);assert.match(help.steps.join(' '),/Maximum positions/);
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  for(const link of help.links)assert.ok(link.target.startsWith('config-')?FIELDS.some(field=>'config-'+field.key===link.target):html.includes(`id="${link.target}"`));
  assert.equal(activityHelp({kind:'scan_summary',data:{'intraday:some_candidate':1}}),null);
  const unknown=activityHelp({kind:'engine_error',level:'error',message:'secret-url private-key',data:{detail:'private-key'}});
  assert.doesNotMatch(JSON.stringify(unknown),/private-key|secret-url/);
});
