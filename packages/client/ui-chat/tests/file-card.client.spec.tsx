// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { UserMessageNodeView, sessionFileHref } from '../src/client/chat/MessageItem.tsx'
import { zh } from '../src/client/locale.ts'
import type { ChatConversationViewNode } from '../src/client/contract/chat-nodes.ts'

afterEach(() => {
  cleanup()
})

const t: ChatNodeViewProps['t'] = makeTranslate(zh, commonZh)
const renderMessageImages: ChatNodeViewProps['renderMessageImages'] = () => null
const useDetachedChat: ChatNodeViewProps['useChat'] = bindSnapshotSelector({
  subscribe: () => () => {},
  getSnapshot: () => ({ order: [], nodes: new Map() }),
} as never)

function fileNode(): ConversationNode {
  return {
    kind: 'user',
    seq: 1,
    time: 1000,
    data: {
      content: [{
        type: 'file',
        attachment: { attachmentId: 'sha256:abc', name: 'notes.txt', bytes: 5 },
      }],
      time: 1000,
    },
  } as unknown as ConversationNode
}

function viewNode(node: ConversationNode): ChatConversationViewNode {
  return {
    key: 'fixture:user:1',
    kind: 'user',
    id: '1',
    target: 'chat',
    anchorSeq: 1,
    location: { kind: 'session' },
    visibility: 'visible',
    data: (node as { data: unknown }).data,
  } as unknown as ChatConversationViewNode
}

function renderDurable(sessionId: string | undefined) {
  const props = {
    node: viewNode(fileNode()),
    t,
    renderMessageImages,
    openFile: vi.fn(),
    openSkill: vi.fn(),
    useChat: useDetachedChat,
    ...(sessionId === undefined ? {} : { sessionId }),
  } as unknown as ChatNodeViewProps<'user' | 'steering'>
  return render(<UserMessageNodeView {...props} />)
}

describe('session file card link', () => {
  it('builds the typed binary download URL from opaque identities', () => {
    expect(sessionFileHref('session-a', 'sha256:abc')).toBe(
      '/api/session/file?sessionId=session-a&attachmentId=sha256%3Aabc',
    )
  })

  it('renders the durable file card as a download anchor', () => {
    const view = renderDurable('session-a')
    const link = view.container.querySelector('a[href]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toBe('/api/session/file?sessionId=session-a&attachmentId=sha256%3Aabc')
    expect(link?.textContent).toContain('notes.txt')
  })

  it('keeps a plain card when no session scope is available', () => {
    const view = renderDurable(undefined)
    expect(view.container.querySelector('a[href]')).toBeNull()
    expect(view.container.querySelector('span[title="notes.txt"]')?.textContent).toContain('notes.txt')
  })
})
