// One chunk per language: the app's catalogue and the UI kit's (`ui.*`), merged.
import type en from './catalog.en'
import app from './messages/ru.json'
import ui from '@knowledge/ui/messages/ru.json'

// English is the key vocabulary: a gap in either Russian catalogue fails vue-tsc here.
const ru: typeof en = { ...app, ...ui }
export default ru
