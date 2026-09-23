import fs from 'fs';
import path from 'path';

const CHUNK_SIZE = 100;

const regexFn = (text) => new RegExp(text, 'ig');
const regexFnCase = (text) => new RegExp(text, 'g');

const typeoMap = {
    'hoard room': ['horde room'].map(regexFn),
    'Haven Hold': ['Haven Hordes', '\\bHaven Horde\\b'].map(regexFn),
    'Sunder Chase': ['Thunder Chase'].map(regexFn),

    Gerk: ['\\bSkirk\\b', '\\bGirk\\b', 'Virk', 'Burke', 'Skeletorrrrrrrrrr', '\\bKirk\\b', 'Greg', 'Gurk', 'Guck', 'Kerrick', 'Gert', 'Gurks', '\\bDirk\\b', '\\bGerg\\b', '\\bUrk\\b', '\\bBurk\\b'].map(regexFn),
    Ciri: ['Siri', '\\bKyle\\b'].map(regexFn),
    Vecna: ['Vecta', 'Bechna', 'Vacna'].map(regexFn),
    Grixto: ['Erixto', 'Erxito', '\\bGorixdale\\b'].map(regexFn),
    Nevarr: ['Navar'].map(regexFn),
    Ire: ['Tryr', '\\bTyr\\b'].map(regexFn),
    Nira: ['Nereana'].map(regexFn),
    // 'Plymouth Gawater': ['Pliveth'].map(regexFn),
    'Plymouth': ['Pliveth', 'Klymouth', 'Clymouth'].map(regexFn),
    'Gawater': ['Guile water', 'Guilewater', 'Guy Water', 'Gowater'].map(regexFn),
    // "Jotun Prime" before bare "Jotun", so the person is not rewritten as the place.
    'Juten Prime': ['Yoden Prime', 'Jotun Prime', 'Jotin Prime'].map(regexFn),
    Jotunheim: ['\\bJotun\\b', 'Jogelheim', 'Jagelheim', 'Jogoheim'].map(regexFn),
    // Silen/Silon/silin must be whole words. Otherwise "Silent" becomes "Sylant".
    Sylan: [...['Leotin', '"Triple Champ"-E-Tan', '\\bSilen\\b', '\\bSilon\\b', '\\bsilin\\b', '\\bSilan\\b', 'Zylin'].map(regexFn), regexFnCase('\\bSilent\\b')],
    Araden: ['\\bRaiden\\b', '\\bRaedon\\b', '\\bRayoden\\b', '\\bBrayaden\\b', 'Ray Itin'].map(regexFn),
    Navi: ['Navee', 'Narvee', 'na V '].map(regexFn),
    Ivellio: ['Ivellion', 'Vilios'].map(regexFn),
    Glimmen: ['Clement', 'Clemin', 'Glimmund', 'Glimond', 'Glimmond', 'Lemon', '\\bGlimmind\\b', '\\bGlimmin\\b', '\\bGlimmand\\b', '\\bGlimind\\b', 'Glimmend'].map(regexFn),
    Mahali: ['Bahali'].map(regexFn),
    Elrus: ['Elris', "Elder's"].map(regexFn),
    Atlas: ['Atlantic'].map(regexFn),
    Feldspar: ['Feld Space', 'Feldspietes', 'Welt spar', 'Felsba', 'Beld Spar', 'Fell spa'].map(regexFn),
    Renard: ['Bernard'].map(regexFn),
    Emhet: [...['\\bEmet\\b', '\\bAmet\\b', '\\bEmmet\\b'].map(regexFn), regexFnCase('\\bMet\\b')],
    Langdale: ['Lyingdale'].map(regexFn),
    'Pitel': ['Patel', 'Petel'].map(regexFn),
    'Gilbrick': ['Gilbricks', 'Kilbrick', 'Kill Brick', 'kill bricks', 'Gilbert'].map(regexFn),
    'Mit-gar': ['Mitgar', 'Mid Guard'].map(regexFn),
    'Lith': [regexFnCase('\\bLif\\b'), regexFn('\\bLithe\\b')],
    'La-rel': ['Lorel', 'Laurel', 'Tollerel', 'Thorell'].map(regexFn),
    'Al Kurin': ['Alcurin', 'L curin'].map(regexFn),
    Nyx: [regexFnCase('\\bNix\\b')],
    Carlkin: ['\\bCarlton\\b', '\\bCarl can\\b', 'Carla Kid', 'Carl Kid'].map(regexFn),
    dragonborn: ['dragon bore'].map(regexFn),

    'The DM': ['Tongatank'],
    'Walker': ['bbobrien', regexFnCase('\\bB Man\\b')],
    // Aris and Eric are case-sensitive so they do not match inside charisma or generic. org stays insensitive.
    'Ord': [regexFnCase('\\bAris\\b'), regexFnCase('\\bEric\\b'), ...['\\bEris\\b', '\\bOrde\\b', '\\borg\\b', '\\bOrb\\b', '\\bAeris\\b'].map(regexFn)],
    'Dana': ['Danae', 'Beccaaaaa', '\\bIberka\\b', '\\bEcco\\b'].map(regexFn),
    'Kit Anger': ['Kit Angel'].map(regexFn),
    'New Navel': ['Nuneville', 'New Nivelle'].map(regexFn),
    'Sea of Nyx': ['Sea of Nick'].map(regexFn),

}

// loads transcript given date
export const loadTranscript = async (date) => {
  const recapPath = `transcripts/${date}/recap.md`;
  const recap = fs.existsSync(recapPath) ? fs.readFileSync(recapPath, 'utf8') : '';
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

