/**
 * The price form a model is priced with, on the default provider's dialog and a
 * model's own alike. `effectiveModelPrice` is the one rule; this holds the strings
 * being typed and what Save would store.
 */
import { computed, reactive } from 'vue'
import { effectiveModelPrice, GEN_API_COST_CURRENCY } from '@knowledge/contracts'
import type { AiProvider, ConfiguredPrice, CostCurrency } from '@knowledge/contracts'
import { parsePrice } from './provider-rows'

const priceText = (n: number | null | undefined) => (n == null ? '' : String(n))

/** @param model The model the price applies to. @param kind Who serves it: GenAPI's own price list is in rubles. */
export function usePriceFields(model: () => string, kind: () => AiProvider) {
  const form = reactive({
    prompt: '',
    completion: '',
    cachedPrompt: '',
    // Null until someone picks one or a row has one: then the provider kind decides.
    currency: null as CostCurrency | null,
  })

  function load(row?: ConfiguredPrice) {
    form.prompt = priceText(row?.pricePromptPerMTok)
    form.completion = priceText(row?.priceCompletionPerMTok)
    form.cachedPrompt = priceText(row?.priceCachedPerMTok)
    // A price stored before #793 has no currency, and was entered in USD.
    form.currency = row?.priceCurrency ?? (row?.pricePromptPerMTok != null || row?.priceCompletionPerMTok != null ? 'USD' : null)
  }

  const listPrice = computed(() => effectiveModelPrice(model()))
  const currency = computed<CostCurrency>(() => form.currency ?? (kind() === 'gen-api' ? GEN_API_COST_CURRENCY : 'USD'))
  /** The list only fills an empty field in its own currency, so only then is it a hint for one. */
  const placeholder = (side: 'prompt' | 'completion' | 'cachedPrompt') => {
    const value = listPrice.value?.currency === currency.value ? listPrice.value[side] : null
    return value == null ? undefined : String(value)
  }

  const parsed = computed(() => ({
    prompt: parsePrice(form.prompt),
    completion: parsePrice(form.completion),
    cachedPrompt: parsePrice(form.cachedPrompt),
  }))
  const valid = computed(() => Object.values(parsed.value).every((value) => value !== undefined))
  /** What Save stores. With no price typed the currency stays unset, so the list applies in its own. */
  const prices = computed<Required<ConfiguredPrice>>(() => {
    const { prompt, completion, cachedPrompt } = parsed.value
    return {
      pricePromptPerMTok: prompt ?? null,
      priceCompletionPerMTok: completion ?? null,
      priceCachedPerMTok: cachedPrompt ?? null,
      priceCurrency: prompt != null || completion != null || cachedPrompt != null ? currency.value : null,
    }
  })
  const willBePriced = computed(() => !valid.value || effectiveModelPrice(model(), prices.value) !== null)

  return { form, load, model, kind, listPrice, currency, placeholder, parsed, valid, prices, willBePriced }
}

export type PriceFields = ReturnType<typeof usePriceFields>
