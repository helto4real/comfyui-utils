# Prompt Enhancer managed privacy

Prompt Enhancer is bound to the complete Utils `helto-privacy` profile. Local
workflow encryption, credential persistence, and credential routes are no
longer authoritative.

The fragment declares one private-by-default `prompt-enhancer` scope,
the `script` and `variables` workflow fields, one semantic execution projection,
and one revisioned `prompt-provider-settings` singleton. Script and variable
plaintext is applied only to the in-memory editor state; protected widget values
remain authoritative for serialization. Lock/session changes clear both editor
fields without replacing their ciphertext.

Execution decrypts the exact settled snapshot through the shared handle. Its
semantic projection contains the resolved plaintext script plus normalized
variables; public external-prompt selection and seeded substitution are applied
at dispatch. The consumer then delegates to existing Prompt Enhancer
product/provider code. It does not decrypt, default, or recover a failed
protected value itself.

Provider settings persist as an opaque singleton envelope with optimistic
revision replacement and verified read-back. Public status is limited to
`tokenConfigured`, `envTokenAvailable`, and `authSource` (plus the existing
`ok` flag). Environment availability uses a separate boolean probe; the token
resolver itself is never called by status. A configured or environment token is passed only into the narrow
authorized provider callback and is never included in status, persistence
metadata, receipts, or object representations.

The credential-aware provider adapter covers writer generation, visual-context
generation, and explicit model downloads. It passes the token separately from
`PromptEnhancerRequest`, so request representations and normal product state
cannot retain it. Provider calls receive credentials only through the
authorized dispatch adapter.

Migration recognizes only these exact sources:

- v1 `{version, hf_token}` plaintext settings;
- v2 `{version, hf_token_encrypted}` wrapping an exact current Utils envelope;
- all four historical Utils workflow generations for both protected fields,
  after their declared binary key imports.

Both workflow fields are discovered first, normalized by product rules, then
rewritten through one `complete_many` transaction and one receipt. A failure in
either field restores both original serialized values; a concurrent source
change is never overwritten.

The provider source file is replaced only after the singleton write is read
back and decrypted to the expected normalized credential. Any commit or
verification failure restores the source bytes and keeps the shared migration
obligation unresolved.
