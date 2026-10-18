/**
 * Inline nodes and marks: status lozenges and document mentions. The specs
 * live in `@knowledge/editor-schema`; this file adds node views and commands.
 *
 * Status is a *mark*, not an atom node, on purpose: the text stays in the
 * paragraph, so it keeps flowing with the sentence, stays editable in place,
 * and — the part that matters — stays visible to the chunker that embeds this
 * page. An atom would have hidden the word inside a node attribute.
 */
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import {
  AgentMention as AgentMentionSpec,
  DocMention as DocMentionSpec,
  StatusMark as StatusMarkSpec,
  UserMention as UserMentionSpec,
} from '@knowledge/editor-schema'
import type { StatusColor } from '@/lib/markdown/nodes'
import MentionNode from '../nodes/MentionNode.vue'
import UserMentionNode from '../nodes/UserMentionNode.vue'
import AgentMentionNode from '../nodes/AgentMentionNode.vue'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    knInline: {
      setStatus: (color: StatusColor) => ReturnType
      toggleStatus: (color: StatusColor) => ReturnType
      unsetStatus: () => ReturnType
      insertDocMention: (attrs: { documentId: string; label: string }) => ReturnType
      insertUserMention: (attrs: { userId: string; label: string }) => ReturnType
      insertAgentMention: (attrs: { agentKey: string; label: string }) => ReturnType
    }
  }
}

export const StatusMark = StatusMarkSpec.extend({
  addCommands() {
    return {
      setStatus:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      toggleStatus:
        (color) =>
        ({ commands, editor }) =>
          editor.isActive(this.name, { color })
            ? commands.unsetMark(this.name)
            : commands.setMark(this.name, { color }),
      unsetStatus:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    }
  },
})

export const DocMention = DocMentionSpec.extend({
  addNodeView() {
    return VueNodeViewRenderer(MentionNode)
  },

  addCommands() {
    return {
      insertDocMention:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent([
            { type: this.name, attrs },
            { type: 'text', text: ' ' },
          ]),
    }
  },
})

export const UserMention = UserMentionSpec.extend({
  addNodeView() {
    return VueNodeViewRenderer(UserMentionNode)
  },

  addCommands() {
    return {
      insertUserMention:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent([
            { type: this.name, attrs },
            { type: 'text', text: ' ' },
          ]),
    }
  },
})

export const AgentMention = AgentMentionSpec.extend({
  addNodeView() {
    return VueNodeViewRenderer(AgentMentionNode)
  },

  addCommands() {
    return {
      insertAgentMention:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent([
            { type: this.name, attrs },
            { type: 'text', text: ' ' },
          ]),
    }
  },
})
