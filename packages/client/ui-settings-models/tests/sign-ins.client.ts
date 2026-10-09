/** An empty account sign-in face for specs that render the Models section without exercising sign-in. */
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSignInSource } from '../src/client/sign-in-source.ts'

const refused = () => Promise.reject(new Error('this spec signs in to nothing'))

/** @returns the `useSignIns` and `signIn` members of the section's injected face. */
export function noSignIns() {
  const source = createSignInSource({
    begin: refused, answer: refused, cancel: refused, signOut: refused, open: () => undefined, opensPages: false,
  })
  return { useSignIns: bindSnapshotSelector(source.store), signIn: source.actions }
}
