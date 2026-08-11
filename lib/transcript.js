import fs from 'fs';
import path from 'path';

const CHUNK_SIZE = 100;

const regexFn = (text) => new RegExp(text, 'ig');

const typeoMap = {
    Gerk: ['Girk', 'Virk', 'Burke', 'Skeletorrrrrrrrrr', 'Kirk', 'Greg', 'Gurk', 'Guck', 'Kerrick', 'Gert', 'Gurks'].map(regexFn),
    Ciri: ['Siri', 'Kyle'].map(regexFn),
    Vecna: ['Vecta', 'Bechna', 'Vacna'].map(regexFn),
    Grixto: ['Erixto', 'Erxito'].map(regexFn),
    Nevarr: ['Navar'].map(regexFn),
    Ire: ['Tryr', 'Tyr'].map(regexFn),
    Nira: ['Nereana'].map(regexFn),
    'Juten': ['Yoden', 'Jotun', 'yoten', 'Jotin'].map(regexFn),
    // 'Juten Prime': ['Yoden Prime'].map(regexFn),
    // 'Plymouth Gawater': ['Pliveth'].map(regexFn),
    'Plymouth': ['Pliveth', 'Klymouth', 'Clymouth'].map(regexFn),
    'Gawater': ['Guile water', 'Guilewater', 'Guy Water'].map(regexFn),
    Jogelheim: ['Jotunheim', 'Jogelheim', 'Jagelheim', 'Jogoheim'].map(regexFn),
    Sylan: [...['Leotin', '"Triple Champ"-E-Tan', 'Silen', 'Silon', 'silin'].map(regexFn), 'Silent'],
    Araden: ['Raiden'].map(regexFn),
    Navi: ['Navee', 'Narvee', 'na V '].map(regexFn),
    Ivellio: ['Ivellion', 'Vilios'].map(regexFn),
    Glimmen: ['Clement', 'Clemin', 'Glimmund', 'Glimond', 'Glimond', 'Glimmond', 'Lemon'].map(regexFn),
    Mahali: ['Bahali'].map(regexFn),
    Elrus: ['Elris'].map(regexFn),
    Atlas: ['Atlantic'].map(regexFn),
    Feldspar: ['Feld Space', 'Feldspietes', 'Welt spar', 'Felsba', 'Beld Spar', 'Fell spa'].map(regexFn),
    Renard: ['Bernard'].map(regexFn),
    Emhet: [...['Emet'].map(regexFn), 'Met'], // hopefully this keeps it case sensitive
    Langdale: ['Lyingdale'].map(regexFn),
    'Pitel': ['Patel', 'Petel'].map(regexFn),
    'Gilbrick': ['Gilbricks', 'Kilbrick', 'Kill Brick', 'kill bricks', 'Gilbert'].map(regexFn),
    'Mit-gar': ['Mitgar', 'Mid Guard'].map(regexFn),
    'Lith': ['Lif', 'Lithe'].map(regexFn),
    'La-rel': ['Lorel', 'Laurel', 'Tollerel', 'Thorell'].map(regexFn),

    'The DM': ['Tongatank'],
    'Walker': ['bbobrien'],
    'Ord': ['Aris', 'Eris', 'Eric', 'Orde'].map(regexFn),
    'Dana': ['Danae', 'Beccaaaaa'].map(regexFn),
    'Kit Anger': ['Kit Angel'].map(regexFn),

}

// loads transcript given date
export const loadTranscript = async (date) => {
  const recap = fs.readFileSync(`transcripts/${date}/recap.md`, 'utf8');
  const transcript = fs.readFileSync(`transcripts/${date}/transcript.md`, 'utf8');
  const totalLines = transcript.split('\n').length;
  console.log(`Total lines: ${totalLines}`);
  return { recap, transcript };
}

// cleanup transcript
export const cleanupTranscript = (transcript) => {
    for (const [key, values] of Object.entries(typeoMap)) {
        for (const value of values) {
            transcript = transcript.replaceAll(value, key);
        }
    }
    return transcript;
}

// divide transcript into chunks
export const divideTranscriptIntoChunks = (transcript) => {
    transcript = cleanupTranscript(transcript);
  const messages = transcript.split('\n\n');
  const chunks = [];
  let currentChunk = [];
  for (const message of messages) {
    currentChunk.push(message);
    if (currentChunk.length > CHUNK_SIZE) {
      chunks.push(currentChunk);
      currentChunk = [];
    }
  }
  return chunks;
}

// gnerator of transcript chucnks, it should provide a few messages from the previous and next chunks for context
export function* generateTranscriptChunks(transcript) {
  const chunks = divideTranscriptIntoChunks(transcript);
  console.log(`Total chunks: ${chunks.length}`);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const previousMessages = i > 0 ? chunks[i - 1] : [];
    const chunkText = `${previousMessages.join('\n\n')}\n\n${chunk.join('\n\n')}}`;
    // console.log(`Chunk: ${chunk}`);
    console.log(`Chunk lines: ${chunkText.split('\n').length}`);
    yield chunkText.replaceAll('\n', '<br/>');
  }
}

