import type { Template } from './types'

export const BUILT_IN_TEMPLATES: Template[] = [
  {
    id: 'general',
    name: 'General meeting',
    description: 'Works for most conversations.',
    sections: ['Key points', 'Decisions', 'Open questions', 'Next steps'],
    instructions: 'Keep bullets short and concrete. Group related points.',
    builtIn: true
  },
  {
    id: 'one-on-one',
    name: '1:1',
    description: 'Manager or peer one-on-one.',
    sections: ['Updates', 'Blockers', 'Feedback', 'Career and growth', 'Follow-ups'],
    instructions: 'Capture commitments each person made. Be candid but neutral in tone.',
    builtIn: true
  },
  {
    id: 'customer-discovery',
    name: 'Customer discovery',
    description: 'Learn about a prospect and their problem.',
    sections: ['About them', 'Current workflow', 'Pain points', 'Budget and timeline', 'Objections', 'Next steps'],
    instructions: 'Quote the customer verbatim when a phrase captures a pain point well.',
    builtIn: true
  },
  {
    id: 'sales-call',
    name: 'Sales call',
    description: 'Qualify and advance a deal.',
    sections: ['Context', 'Needs', 'Decision process', 'Competition', 'Pricing discussed', 'Next steps'],
    instructions: 'Note who the decision makers and champions are.',
    builtIn: true
  },
  {
    id: 'standup',
    name: 'Stand-up',
    description: 'Daily team sync.',
    sections: ['Per person: done, doing, blocked', 'Team blockers', 'Follow-ups'],
    instructions: 'Organise by person. One line each where possible.',
    builtIn: true
  },
  {
    id: 'interview',
    name: 'Candidate interview',
    description: 'Hiring interview notes.',
    sections: ['Background', 'Strengths', 'Concerns', 'Signals by competency', 'Recommendation'],
    instructions: 'Stick to evidence from the conversation. Do not invent a hiring decision.',
    builtIn: true
  },
  {
    id: 'investor',
    name: 'Investor pitch',
    description: 'Fundraising conversation.',
    sections: ['Fund and partner', 'Their questions', 'Concerns raised', 'Interest level', 'Next steps'],
    instructions: 'Capture every diligence request as a next step.',
    builtIn: true
  }
]
