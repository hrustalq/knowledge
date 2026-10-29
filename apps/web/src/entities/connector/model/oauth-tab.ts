/**
 * Opens a provider's authorization page in a new tab and calls `onReturn`
 * when this tab regains focus — coming back is when the answer may have
 * changed (the GitHub picker's rule). The tab opens before `url` resolves,
 * still inside the click, so a popup blocker lets it through.
 */
export async function openOauthTab(url: () => Promise<string>, onReturn: () => unknown): Promise<void> {
  const tab = window.open('about:blank', '_blank')
  try {
    const target = await url()
    if (tab) {
      tab.opener = null
      tab.location.href = target
    } else {
      window.open(target, '_blank', 'noopener')
    }
  } catch (e) {
    tab?.close()
    throw e
  }
  const back = () => {
    window.removeEventListener('focus', back)
    void onReturn()
  }
  window.addEventListener('focus', back)
}
