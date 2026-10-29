// The editor joins a shared draft only when collab is on; Yjs and the provider stay out of its chunk until then.
export const loadCollab = () => import('./use-collab')
