import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { parseGroupFilter, parseUserFilter } from './scim-filter.js';
import { applyGroupPatch, applyUserPatch, readPatch, scimBoolean } from './scim-patch.js';

/**
 * The SCIM readers (#75 phase 5): the filter subset and PATCH as Entra ID,
 * Okta and the Keycloak SCIM plugin actually send them.
 */

describe('parseUserFilter', () => {
  it.each([
    ['userName eq "ada@corp.example"', 'userName', 'ada@corp.example'],
    ['UserName EQ "Ada@Corp.Example"', 'userName', 'Ada@Corp.Example'],
    ['urn:ietf:params:scim:schemas:core:2.0:User:userName eq "ada"', 'userName', 'ada'],
    ['externalId eq "00u1abc"', 'externalId', '00u1abc'],
    ['emails[type eq "work"].value eq "ada@corp.example"', 'email', 'ada@corp.example'],
    ['emails[ type eq "Work" ].value eq "ada@corp.example"', 'email', 'ada@corp.example'],
    ['emails.value eq "ada@corp.example"', 'email', 'ada@corp.example'],
    ['id eq "a1"', 'id', 'a1'],
    ['userName eq "quote \\" inside"', 'userName', 'quote " inside'],
  ])('%s', (raw, attribute, value) => {
    expect(parseUserFilter(raw)).toEqual({ attribute, value });
  });

  it.each([
    'userName co "ada"',
    'userName eq "a" and active eq true',
    'displayName eq "Ada"',
    'userName eq ada',
    'userName pr',
    '',
  ])('refuses %j', (raw) => {
    expect(parseUserFilter(raw)).toBeNull();
  });
});

describe('parseGroupFilter', () => {
  it('reads displayName and externalId, case-insensitively by attribute', () => {
    expect(parseGroupFilter('displayName eq "Knowledge Editors"')).toEqual({ attribute: 'displayName', value: 'Knowledge Editors' });
    expect(parseGroupFilter('externalid eq "g-1"')).toEqual({ attribute: 'externalId', value: 'g-1' });
    expect(parseGroupFilter('userName eq "x"')).toBeNull();
  });
});

describe('readPatch', () => {
  it("lower-cases Entra's capitalised ops", () => {
    expect(readPatch({ Operations: [{ op: 'Replace', path: 'active', value: 'False' }] })).toEqual([
      { op: 'replace', path: 'active', value: 'False' },
    ]);
  });

  it('refuses a body without operations, an unknown op, and a remove without a path', () => {
    expect(() => readPatch({})).toThrow("error.scim.patchOperations");
    expect(() => readPatch({ Operations: [{ op: 'move', path: 'x' }] })).toThrow("error.scim.patchOp");
    expect(() => readPatch({ Operations: [{ op: 'remove' }] })).toThrow("error.scim.patchRemoveNeedsPath");
  });
});

describe('scimBoolean', () => {
  it('reads real booleans and the strings Entra sends', () => {
    expect([true, false, 'True', 'False', 'false ', 'yes', 1].map(scimBoolean)).toEqual([true, false, true, false, false, undefined, undefined]);
  });
});

describe('applyUserPatch', () => {
  const ada = {
    userName: 'ada@corp.example',
    name: { givenName: 'Ada', familyName: 'Lovelace' },
    emails: [{ value: 'ada@corp.example', type: 'work', primary: true }],
    active: true,
  };

  it('sets a plain path, a sub-attribute and a value-filtered one (Entra)', () => {
    const out = applyUserPatch(ada, readPatch({
      Operations: [
        { op: 'Replace', path: 'active', value: 'False' },
        { op: 'Replace', path: 'name.familyName', value: 'King' },
        { op: 'Replace', path: 'emails[type eq "work"].value', value: 'ada.king@corp.example' },
        { op: 'Add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'Analytics' },
      ],
    }));
    expect(out).toMatchObject({
      active: 'False',
      name: { givenName: 'Ada', familyName: 'King' },
      emails: [{ value: 'ada.king@corp.example', type: 'work', primary: true }],
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'Analytics' },
    });
    expect(ada.active).toBe(true);
  });

  it('applies a path-less replace with the whole object, ignoring id (Okta)', () => {
    const out = applyUserPatch(ada, readPatch({ Operations: [{ op: 'replace', value: { id: 'x', active: false, 'name.givenName': 'Augusta' } }] }));
    expect(out).toMatchObject({ active: false, name: { givenName: 'Augusta', familyName: 'Lovelace' } });
    expect(out).not.toHaveProperty('id');
  });

  it('creates a filtered element that is missing, and removes one by filter', () => {
    const added = applyUserPatch({ userName: 'a' }, readPatch({ Operations: [{ op: 'add', path: 'emails[type eq "work"].value', value: 'a@x.example' }] }));
    expect(added.emails).toEqual([{ type: 'work', value: 'a@x.example' }]);
    const removed = applyUserPatch(added, readPatch({ Operations: [{ op: 'remove', path: 'emails[type eq "work"]' }] }));
    expect(removed.emails).toEqual([]);
  });

  it('refuses a path it cannot read', () => {
    expect(() => applyUserPatch(ada, readPatch({ Operations: [{ op: 'replace', path: 'emails[value co "x"]', value: 1 }] }))).toThrow("error.scim.patchPath");
  });
});

describe('applyGroupPatch', () => {
  const group = () => ({ displayName: 'Editors', externalId: null, members: new Set(['u1', 'u2']) });

  it('adds members and removes them by value list (Entra)', () => {
    const out = applyGroupPatch(group(), readPatch({
      Operations: [
        { op: 'Add', path: 'members', value: [{ value: 'u3' }] },
        { op: 'Remove', path: 'members', value: [{ value: 'u1' }] },
      ],
    }));
    expect([...out.members]).toEqual(['u2', 'u3']);
  });

  it('removes a member by filter and renames with a path-less replace (Okta)', () => {
    const out = applyGroupPatch(group(), readPatch({
      Operations: [
        { op: 'remove', path: 'members[value eq "u2"]' },
        { op: 'replace', value: { id: 'g', displayName: 'Writers' } },
      ],
    }));
    expect(out).toMatchObject({ displayName: 'Writers' });
    expect([...out.members]).toEqual(['u1']);
  });

  it('replaces the member list, and a bare remove empties it', () => {
    expect([...applyGroupPatch(group(), readPatch({ Operations: [{ op: 'replace', path: 'members', value: [{ value: 'u9' }] }] })).members]).toEqual(['u9']);
    expect(applyGroupPatch(group(), readPatch({ Operations: [{ op: 'remove', path: 'members' }] })).members.size).toBe(0);
  });

  it('refuses an attribute a group does not have, and an empty name', () => {
    expect(() => applyGroupPatch(group(), readPatch({ Operations: [{ op: 'replace', path: 'owner', value: 'x' }] }))).toThrow("error.scim.patchPath");
    expect(() => applyGroupPatch(group(), readPatch({ Operations: [{ op: 'replace', path: 'displayName', value: ' ' }] }))).toThrow("error.scim.displayNameRequired");
  });
});
