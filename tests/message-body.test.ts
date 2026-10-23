import { describe, expect, it } from 'vitest'

import { hasOwnDesign } from '../src/renderer/app/MessageBody'

describe('hasOwnDesign', () => {
  it('treats mail a person typed as plain, even as HTML with a coloured signature', () => {
    const gmail =
      '<div dir="ltr">Hey team,<br><br>Sharing the data on the thread.<br><div><span style="color:rgb(34,34,34)">Regards,</span><br><font color="#888888">Analyst</font></div></div>'
    expect(hasOwnDesign(gmail)).toBe(false)
  })

  it('ignores the transparent and white backgrounds Docs and Outlook stamp on typed mail', () => {
    const docs =
      '<p dir="ltr"><span style="font-size:11pt;color:#000000;background-color:transparent;font-weight:700">Dear team,</span></p><table bgcolor="#FFFFFF"><tr><td style="background: white">Regards</td></tr></table><div style="background-color: rgb(255, 255, 255)">x</div><span style="background-color:rgba(0,0,0,0)">y</span>'
    expect(hasOwnDesign(docs)).toBe(false)
  })

  it('treats a highlighted phrase as typed mail, not a design', () => {
    expect(hasOwnDesign('<div dir="ltr">Please check <span style="background-color:rgb(255,255,0)">the Q3 numbers</span> today.</div>')).toBe(false)
  })

  it('keeps the light page for newsletters and receipts that paint their own backgrounds', () => {
    expect(hasOwnDesign('<table bgcolor="#f4f4f4"><tr><td>Sale</td></tr></table>')).toBe(true)
    expect(hasOwnDesign('<div style="background-color: #f4f6f8">Receipt</div>')).toBe(true)
    expect(hasOwnDesign('<td style="background:url(x.png)">Hero</td>')).toBe(true)
  })
})
