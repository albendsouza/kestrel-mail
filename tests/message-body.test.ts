import { describe, expect, it } from 'vitest'

import { hasOwnDesign } from '../src/renderer/app/MessageBody'

describe('hasOwnDesign', () => {
  it('treats mail a person typed as plain, even as HTML with a coloured signature', () => {
    const gmail =
      '<div dir="ltr">Hey team,<br><br>Sharing the data on the thread.<br><div><span style="color:rgb(34,34,34)">Regards,</span><br><font color="#888888">Analyst</font></div></div>'
    expect(hasOwnDesign(gmail)).toBe(false)
  })

  it('keeps the light page for newsletters and receipts that paint their own backgrounds', () => {
    expect(hasOwnDesign('<table bgcolor="#f4f4f4"><tr><td>Sale</td></tr></table>')).toBe(true)
    expect(hasOwnDesign('<div style="background-color: #ffffff">Receipt</div>')).toBe(true)
    expect(hasOwnDesign('<td style="background:url(x.png)">Hero</td>')).toBe(true)
  })
})
