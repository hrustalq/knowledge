/**
 * Bank ids the runtime derives for itself (`agent:<key>:user:<userId>`, `project:<projectId>`).
 * A wire caller may not create a bank or an alias under one: the runtime finds its banks by
 * these names, so a squatted name would receive another person's memory.
 */
export const isReservedBankId = (bankId: string): boolean => /^(agent:[^:]+:user:|project:)/.test(bankId);
