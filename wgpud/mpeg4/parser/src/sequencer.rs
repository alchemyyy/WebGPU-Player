// The coordinator's sequence: the codec stream configured from the codec private data plans each packet's pictures in decode order,
// keeps the output events FFmpeg's h263 decode_frame decides (a B picture, and any picture of a low-delay stream, outputs at once; a
// reference picture of a stream with B pictures outputs when the next one is planned), and the anchor motion MPEG-4 B pictures read.

use crate::codec::{AnchorMotion, Configuration, DecodedPicture, PictureInfo};
use crate::error::{self, DecodeResult};
use crate::h263::{H263Plan, H263Stream};
use crate::layout::ERROR_RECORD_INVALID;
use crate::mpeg4::{Mpeg4Plan, Mpeg4Stream};
use crate::mpv::Codec;
use crate::msmpeg4::{MsMpeg4Plan, MsMpeg4Stream};
use crate::plan::{PlanField, PlanReader, PlanWriter};

// Output events: a picture's index in its low 30 bits, and bit 31 to drop it
const PICTURE_INDEX_MASK: u32 = (1 << 30) - 1;
const DROP_EVENT: u32 = 1 << 31;
// The record check failure value of a packet planned before the codec private data configured the stream
pub const NOT_CONFIGURED: u32 = 4;

/// The reference pictures a plan reads: whether every planned reference picture finished, and the latest finished one's motion.
pub struct AnchorState<'a> {
    pub finished: bool,
    pub motion: Option<&'a AnchorMotion>,
}

/// One planning step of a packet.
pub enum PlanStep {
    /// The packet holds no more pictures
    NoPicture,
    /// The picture waits for the reference pictures before it to finish; the stream kept no state
    Blocked,
    /// A picture, and the byte its packet's next picture starts at, if it holds more
    Picture { info: PictureInfo, plan: PicturePlan, next_start: Option<usize> },
}

/// A codec family's stream state on the coordinator.
pub trait CodecStream {
    /// Plans the picture of the packet that starts at byte start.
    fn plan(&mut self, packet: &[u8], start: usize, anchors: &AnchorState) -> DecodeResult<PlanStep>;
    /// The largest picture of the stream's sequence, or the configuration's.
    fn maximum_picture_size(&self) -> (u32, u32);
}

/// A planned picture, which a parse worker decodes.
pub enum PicturePlan {
    Mpeg4(Box<Mpeg4Plan>),
    H263(Box<H263Plan>),
    MsMpeg4(Box<MsMpeg4Plan>),
}

const PLAN_MPEG4: u32 = 1;
const PLAN_H263: u32 = 2;
const PLAN_MSMPEG4: u32 = 3;

impl PicturePlan {
    pub fn decode(&self) -> DecodeResult<DecodedPicture> {
        match self {
            PicturePlan::Mpeg4(plan) => plan.decode(),
            PicturePlan::H263(plan) => plan.decode(),
            PicturePlan::MsMpeg4(plan) => plan.decode(),
        }
    }
}

impl PlanField for PicturePlan {
    fn write(&self, writer: &mut PlanWriter) {
        match self {
            PicturePlan::Mpeg4(plan) => {
                writer.words.push(PLAN_MPEG4);
                plan.write(writer);
            }
            PicturePlan::H263(plan) => {
                writer.words.push(PLAN_H263);
                plan.write(writer);
            }
            PicturePlan::MsMpeg4(plan) => {
                writer.words.push(PLAN_MSMPEG4);
                plan.write(writer);
            }
        }
    }

    fn read(reader: &mut PlanReader) -> Option<Self> {
        match reader.word()? {
            PLAN_MPEG4 => Some(PicturePlan::Mpeg4(Box::new(Mpeg4Plan::read(reader)?))),
            PLAN_H263 => Some(PicturePlan::H263(Box::new(H263Plan::read(reader)?))),
            PLAN_MSMPEG4 => Some(PicturePlan::MsMpeg4(Box::new(MsMpeg4Plan::read(reader)?))),
            _ => None,
        }
    }
}

/// A planned picture waiting for its finish: what it reports.
pub struct PendingPicture {
    pub info: PictureInfo,
}

#[derive(Default)]
pub struct Sequencer {
    stream: Option<Box<dyn CodecStream>>,
    /// The packet of the last plan, and where its next picture starts
    packet: Vec<u8>,
    next_start: Option<usize>,
    next_index: u32,
    /// The reference picture whose output waits for the next reference picture
    waiting_anchor: Option<u32>,
    /// Reference pictures planned and not yet finished
    unfinished_anchors: u32,
    anchor_motion: Option<AnchorMotion>,
    events: Vec<u32>,
}

impl Sequencer {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Configures the stream from the codec private data; the codec its FourCC names decides the stream.
    pub fn configure(&mut self, bytes: &[u8]) -> DecodeResult<()> {
        let configuration: Configuration = Configuration::parse(bytes)?;
        let stream: Box<dyn CodecStream> = match configuration.codec {
            Codec::Mpeg4 => Box::new(Mpeg4Stream::new(&configuration)?),
            Codec::H263 => Box::new(H263Stream::new(&configuration)?),
            Codec::MsMpeg4V1 | Codec::MsMpeg4V2 | Codec::MsMpeg4V3 => Box::new(MsMpeg4Stream::new(&configuration)?),
        };
        let previous: Option<Box<dyn CodecStream>> = self.stream.take();
        self.reset();
        drop(previous);
        self.stream = Some(stream);
        Ok(())
    }

    pub fn maximum_picture_size(&self) -> (u32, u32) {
        self.stream.as_deref().map_or((0, 0), |stream: &dyn CodecStream| stream.maximum_picture_size())
    }

    pub fn events(&self) -> &[u32] {
        &self.events
    }

    /// Plans the first picture of a packet.
    pub fn plan_packet(&mut self, packet: &[u8]) -> DecodeResult<Option<(PendingPicture, PicturePlan)>> {
        self.events.clear();
        self.packet = packet.to_vec();
        self.next_start = Some(0);
        self.plan_next()
    }

    /// Plans the packet's next picture: Ok(None) for no more, Err for a failure; a blocked plan returns the blocked marker as an error
    /// the caller distinguishes with is_blocked.
    pub fn plan_next(&mut self) -> DecodeResult<Option<(PendingPicture, PicturePlan)>> {
        self.events.clear();
        let Some(start) = self.next_start else {
            return Ok(None);
        };
        let Some(stream) = self.stream.as_mut() else {
            return error::fail(ERROR_RECORD_INVALID, NOT_CONFIGURED);
        };
        let anchors: AnchorState = AnchorState { finished: self.unfinished_anchors == 0, motion: self.anchor_motion.as_ref() };
        match stream.plan(&self.packet, start, &anchors)? {
            PlanStep::NoPicture => {
                self.next_start = None;
                Ok(None)
            }
            PlanStep::Blocked => Err(BLOCKED),
            PlanStep::Picture { info, plan, next_start } => {
                self.next_start = next_start;
                if info.reset_anchors {
                    if let Some(waiting) = self.waiting_anchor.take() {
                        self.events.push(waiting | DROP_EVENT);
                    }
                    self.anchor_motion = None;
                }
                let index: u32 = self.next_index;
                self.next_index = (self.next_index + 1) & PICTURE_INDEX_MASK;
                if info.reference {
                    self.unfinished_anchors += 1;
                }
                if info.output_now {
                    if info.reference && let Some(waiting) = self.waiting_anchor.take() {
                        self.events.push(waiting);
                    }
                    self.events.push(index);
                } else {
                    if let Some(waiting) = self.waiting_anchor.take() {
                        self.events.push(waiting);
                    }
                    self.waiting_anchor = Some(index);
                }
                Ok(Some((PendingPicture { info }, plan)))
            }
        }
    }

    /// Whether the packet holds more pictures after the last one planned.
    pub fn has_next(&self) -> bool {
        self.next_start.is_some()
    }

    /// Takes a finished picture's anchor motion, when it is a reference picture.
    pub fn finish(&mut self, pending: &PendingPicture, anchor_motion: Option<AnchorMotion>) {
        if pending.info.reference {
            self.unfinished_anchors = self.unfinished_anchors.saturating_sub(1);
            if anchor_motion.is_some() {
                self.anchor_motion = anchor_motion;
            }
        }
    }
}

/// The marker error of a blocked plan, which no error line names.
pub const BLOCKED: crate::error::DecodeError = crate::error::DecodeError { code: 0, value: 0 };
