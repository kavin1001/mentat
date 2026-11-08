// Seeds a demo data folder (MENTAT_DATA_DIR) with a sample meeting, for screenshots and MCP testing.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.env.MENTAT_DATA_DIR
if (!dir) throw new Error('Set MENTAT_DATA_DIR')
mkdirSync(join(dir, 'meetings'), { recursive: true })
const seg = (speaker, start, text) => ({ id: `s${start}`, speaker, text, start, end: start + 6 })
const m = {
  id: 'demo-acme-discovery',
  title: 'Acme Corp discovery call',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  startedAt: new Date(Date.now() - 3600_000).toISOString(),
  attendees: [{ name: 'Priya Shah', email: 'priya@acme.example' }, { name: 'Tom Reyes', email: 'tom@acme.example' }],
  folderIds: [],
  notes: '- 40 person sales team\n- hates CRM data entry\n- budget Q1?\n- wants SOC 2',
  transcript: [
    seg('me', 0, 'Thanks for making the time. Can you walk me through how your team takes notes on calls today?'),
    seg('them', 7, 'Sure. We have about forty reps and honestly most of them type into a Google Doc and then copy it into Salesforce at the end of the day.'),
    seg('them', 15, 'That copy step is the part everyone hates. We lose maybe thirty minutes per rep per day.'),
    seg('me', 24, 'And where does budget for something like this usually come from?'),
    seg('them', 30, 'Sales ops. We plan for Q1, so if we can get a pilot going in December that would line up.'),
    seg('them', 38, 'The one hard requirement from security is SOC 2 Type II.'),
    seg('me', 45, 'Great. I will send over our security pack and a pilot proposal by Friday.')
  ],
  enhanced: {
    templateId: 'customer-discovery', generatedAt: new Date().toISOString(),
    summary: 'Acme’s 40-rep sales team loses about 30 minutes per rep per day copying call notes into Salesforce. They want a December pilot ahead of Q1 budget, gated on SOC 2 Type II.',
    sections: [
      { heading: 'About them', bullets: [{ text: '40-person sales team', origin: 'user' }, { text: 'Reps take notes in Google Docs today', origin: 'ai' }] },
      { heading: 'Pain points', bullets: [{ text: 'Hates manual CRM data entry', origin: 'user' }, { text: 'Copying notes into Salesforce costs ~30 min per rep per day', origin: 'ai' }] },
      { heading: 'Budget and timeline', bullets: [{ text: 'Budget comes from Sales Ops, planned for Q1', origin: 'user' }, { text: 'Pilot in December would line up with planning', origin: 'ai' }] },
      { heading: 'Objections', bullets: [{ text: 'SOC 2 Type II is a hard requirement from security', origin: 'user' }] }
    ],
    actionItems: [{ owner: 'Me', text: 'Send security pack and pilot proposal', due: 'Friday' }]
  }
}
writeFileSync(join(dir, 'meetings', `${m.id}.json`), JSON.stringify(m, null, 2))
console.log('seeded', dir)
