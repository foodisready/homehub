/** The From header for alert and backup emails. Pure: no database. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fromHeader } from './email';

describe('email From header', () => {
  it('uses the account address when From is blank', () => {
    assert.equal(fromHeader('', 'me@gmail.com'), 'me@gmail.com');
  });

  it('adds the account address to a bare name, as Gmail requires', () => {
    assert.equal(fromHeader('HomeHub', 'me@gmail.com'), '"HomeHub" <me@gmail.com>');
    assert.equal(fromHeader(' Home "Hub" ', 'me@gmail.com'), '"Home Hub" <me@gmail.com>');
  });

  it('keeps a From that already has an address', () => {
    assert.equal(fromHeader('"AuraFlow" <alerts@example.com>', 'me@gmail.com'), '"AuraFlow" <alerts@example.com>');
    assert.equal(fromHeader('alerts@example.com', 'apikey'), 'alerts@example.com');
  });

  it('leaves a bare name alone when the username is not an address', () => {
    assert.equal(fromHeader('HomeHub', 'apikey'), 'HomeHub');
  });
});
