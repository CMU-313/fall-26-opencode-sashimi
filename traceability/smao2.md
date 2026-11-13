# Traceability: Steven Mao (smao2)

**Target feature:** <feature, and the main source files it lives in>

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test |
|---|---|---|---|---|---|---|
| R1 | S-7: “Something concrete to test would be to test the length, which is simpler.” |
When a title is generated, assert that the length is < 5 words.|
UNCHANGED|
INVARIANT| | |

| R2 |S-8: “That could work, a lot of techniques pre LLMs use that in order to test, so it could work, I think that’s a good one.” |
When a title is generated, have at least one word be in the conversation history.|
UNCHANGED|
INVARIANT| | |

| R3 | O-4: If I rename and then run autoname again, it should not change it back to its original title, because it should assume that the user didn’t find the title satisfactory. |
When the title is generated, save it then generate another title, and make sure they are not the same.|
UNCHANGED|
ALGEBRAIC| | |

| R4 | O-3: When using /autoname, I wouldn’t expect the chat to change, the UI shouldn’t change, if it breaks the UI then it is not functional, it shouldn’t change the agent that I’m using. |
Assert that all the message history is the same, and that the model is the same before and after the command.|
UNCHANGED|
INVARIANT| | |

| R5 |  S-1: I, like many people, have heard a lot of rogue AIs, so I would like to have fine grained permissions so it doesn’t touch what it doesn’t have to and also tells me what it will do before it does it so I can verify. | 
Permissions for the AI should be restricted while the autoname command is being run, and the flags unrelated to title should be denied edit access.
|NOT IMPLEMENTED| | | |

Properties written or suggested by opencode or another AI tool: <list by requirement ID, or "none">:<"none">

## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|R2||When a title is generated, assert that the length is < 5 words.|When a title is generated, assert that the length is <= 5 words.|

This was a misunderstanding of my previous requirements, the title should be 2-5 words long, which includes 5.