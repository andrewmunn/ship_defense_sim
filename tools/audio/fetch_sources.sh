#!/usr/bin/env bash
# Download every third-party source recording used by build_bank.py into tools/audio_work/raw
# and record license metadata in tools/audio_work/raw/_sources.json. All sources are public domain
# (U.S. Navy / DoD) or CC0 1.0 (Freesound).
set -euo pipefail
cd "$(dirname "$0")"
PY=../../.venv/bin/python
# Wikimedia Commons (U.S. Navy / DoD, public domain)
$PY commons_get.py \
  "USS Bainbridge Conducts a CWIS Pre-Action Calibration (1000563).webm" \
  "US Navy CIWS System firing.webm" \
  "230520-N-UD253-915 - USS Oscar Austin (DDG-79) Completes an SM-2 Engagement In Support of Exercise Formidable Shield 2023.webm" \
  "230520-N-NQ285-2004 - USS Porter SM-2 launch Formidable Shield 2023.webm"
# DVIDS (U.S. Navy, public domain)
$PY dvids_get.py \
  https://www.dvidshub.net/video/937504/uss-dewey-fires-5-inch-gun-during-live-fire-exercise-philippine-sea \
  https://www.dvidshub.net/video/836211/uss-dewey-fires-5-inch-gun
# Freesound (CC0 1.0) - HQ OGG previews
$PY freesound.py get 50623 167684 181562 187767 194364 262436 264889 316744 320788 360631 398851 442773 \
  477132 496836 515122 515123 529794 550342 551436 556714 563765 569555 570927 675486 698209 703247 74915 235968
# short aliases used by the build scripts
cd ../audio_work/raw
ln -sf "USS_Bainbridge_Conducts_a_CWIS_Pre-Action_Calibration_(1000563).webm" bainbridge.webm
ln -sf "US_Navy_CIWS_System_firing.webm" usn_ciws.webm
ln -sf "230520-N-UD253-915_-_USS_Oscar_Austin_(DDG-79)_Completes_an_SM-2_Engagement_In_Support_of_Exercise_Formidable_Shield_2023.webm" austin_sm2.webm
ln -sf "230520-N-NQ285-2004_-_USS_Porter_SM-2_launch_Formidable_Shield_2023.webm" porter_sm2.webm
