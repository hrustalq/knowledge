// One chunk per language: the app's catalogue and the UI kit's (`ui.*`), merged.
import app from './messages/en.json'
import ui from '@knowledge/ui/messages/en.json'

export default { ...app, ...ui }
