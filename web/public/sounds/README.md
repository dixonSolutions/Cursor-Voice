# Voice UI sound cues

Kenney [UI Audio](https://kenney.nl/assets/ui-audio) pack (CC0). Regenerate: `bash scripts/prepare-voice-cues.sh`

| File | Kenney source | When | UX role |
| --- | --- | --- | --- |
| `listening.mp3` | `rollover4.wav` | Wake phrase detected | Short **beep** — mic open, start speaking |
| `sent.mp3` | `click3.wav` | Turn submitted (VAD, end phrase, or silence) | Soft **boop** — message dispatched |
| `cancel.mp3` | `switch2.wav` | Cancel phrase during capture | **Toggle-off** — turn discarded, back to idle |

**License:** [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) — Kenney Vleugels. Attribution optional.

**Why these three?** Voice UIs use distinct earcons per state (Alexa attention system, Material Design, NN/g): a neutral activation ping, a positive send confirmation, and a terminating dismiss — not an error tone.
