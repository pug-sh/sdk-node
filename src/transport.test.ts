import { expect, it, vi } from 'vitest'
import { createEventSink } from './transport.js'

it('warns with the reasons when the server drops events', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const batchCreate = async () => ({ accepted: 1, dropped: 2, droppedByReason: { day_out_of_range: 2 } })
  await createEventSink({ batchCreate } as never).sendBatch([{}, {}, {}] as never)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 2 of 3'), { day_out_of_range: 2 })
  warn.mockRestore()
})
