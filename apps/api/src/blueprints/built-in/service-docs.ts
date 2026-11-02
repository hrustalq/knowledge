import type { Blueprint } from '@knowledge/contracts';
import { page } from './page.js';

/** Service documentation (#716): a running service's model, API, processes, UI, integrations and tests. */
export const SERVICE_DOCS_BLUEPRINT: Blueprint = {
  name: { en: 'Service documentation', ru: 'Документация сервиса' },
  description: {
    en: 'For a service in production: its information model, API methods, processes, screens, integrations and tests.',
    ru: 'Для работающего сервиса: информационная модель, методы API, процессы, экраны, интеграции и тесты.',
  },
  icon: '📚',
  tree: [
    page('Overview', 'Обзор', {
      guidance: ['What the service is, what it must do, and where it is going.', 'Что это за сервис, что он должен делать и куда развивается.'],
      children: [
        page('Description', 'Описание'),
        page('Requirements', 'Требования'),
        page('Links', 'Ссылки', { category: 'reference' }),
        page('Roadmap', 'Дорожная карта'),
      ],
    }),
    page('Information model', 'Информационная модель', {
      category: 'erd',
      collection: { template: 'builtin:entity' },
      guidance: ['One page per entity the service stores.', 'По странице на каждую сущность, которую хранит сервис.'],
    }),
    page('API', 'API', {
      category: 'contract',
      collection: { template: 'builtin:api-spec' },
      guidance: ['One page per API method.', 'По странице на каждый метод API.'],
    }),
    page('Processes', 'Процессы', {
      category: 'process',
      collection: {},
      guidance: ['One page per business process the service runs.', 'По странице на каждый бизнес-процесс сервиса.'],
    }),
    page('UI/UX', 'UI/UX', {
      category: 'use-case',
      collection: { template: 'builtin:use-case' },
      guidance: ['One page per screen or user scenario.', 'По странице на экран или пользовательский сценарий.'],
    }),
    page('Integrations', 'Интеграции', {
      category: 'architecture',
      collection: {},
      guidance: ['One page per external system the service talks to.', 'По странице на каждую внешнюю систему, с которой работает сервис.'],
    }),
    page('Testing', 'Тестирование', {
      collection: { template: 'builtin:test-case' },
      guidance: ['One page per test case.', 'По странице на каждый тест-кейс.'],
    }),
    page('Role model', 'Ролевая модель', { guidance: ['Who can do what in the service.', 'Кто что может делать в сервисе.'] }),
    page('FAQ', 'FAQ', { category: 'guide', guidance: ['Questions people actually ask, with answers.', 'Вопросы, которые действительно задают, с ответами.'] }),
    page('Deprecated', 'Устаревшее', {
      guidance: ['Pages that no longer describe the service, moved here rather than deleted.', 'Страницы, которые больше не описывают сервис, — перенесённые сюда, а не удалённые.'],
    }),
  ],
};
