import { useEffect, useState, useRef } from 'react';
import { AudioVisualizer } from './components/AudioVisualizer';
import Progress from './components/Progress';
import { LanguageSelector } from './components/LanguageSelector';
import FaceDetection from './components/FaceDetection';

const IS_WEBGPU_AVAILABLE = !!navigator.gpu;

const WHISPER_SAMPLING_RATE = 16_000;
const MAX_AUDIO_LENGTH = 30; // seconds
const MAX_SAMPLES = WHISPER_SAMPLING_RATE * MAX_AUDIO_LENGTH;

function App() {
  // Create a reference to the worker object.
  const worker = useRef(null);
  const recorderRef = useRef(null);

  // Model loading and progress
  const [status, setStatus] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [progressItems, setProgressItems] = useState([]);

  // Inputs and outputs
  const [text, setText] = useState('');
  const [tps, setTps] = useState(null);
  const [language, setLanguage] = useState('en');

  // Processing
  const [recording, setRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [chunks, setChunks] = useState([]);
  const [stream, setStream] = useState(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const audioContextRef = useRef(null);

  // Add new state for face detection
  const [faceData, setFaceData] = useState(null);
  // Add state for detected name
  const [detectedName, setDetectedName] = useState(null);

  // Add state for API response and loading status
  const [apiResponse, setApiResponse] = useState(null);
  const [isApiLoading, setIsApiLoading] = useState(false);

  // Add chat state
  const [chats, setChats] = useState([[]]); // Each chat is an array of exchanges
  const [currentChatIndex, setCurrentChatIndex] = useState(0);
  const [pendingExchange, setPendingExchange] = useState(null); // Temporarily store person/speech until Gemini reply

  // Worker setup
  useEffect(() => {
    if (!worker.current) {
      worker.current = new Worker(new URL('./worker.js', import.meta.url), {
        type: 'module'
      });
    }

    const onMessageReceived = (e) => {
      switch (e.data.status) {
        case 'loading':
          setStatus('loading');
          setLoadingMessage(e.data.data);
          break;
        case 'initiate':
          setProgressItems(prev => [...prev, e.data]);
          break;
        case 'progress':
          setProgressItems(
            prev => prev.map(item => {
              if (item.file === e.data.file) {
                return { ...item, ...e.data }
              }
              return item;
            })
          );
          break;
        case 'done':
          setProgressItems(
            prev => prev.filter(item => item.file !== e.data.file)
          );
          break;
        case 'ready':
          setStatus('ready');
          break;
        case 'start': {
          setIsProcessing(true);
          recorderRef.current?.requestData();
        }
          break;
        case 'update': {
          const { tps } = e.data;
          setTps(tps);
        }
          break;
        case 'complete':
          console.log('Worker complete:', e.data.output); // Debug: Log transcription output
          setIsProcessing(false);
          setText(e.data.output);
          break;
      }
    };

    worker.current.addEventListener('message', onMessageReceived);
    return () => {
      worker.current.removeEventListener('message', onMessageReceived);
    };
  }, []);

  // Media setup
  useEffect(() => {
    if (recorderRef.current) return;

    if (navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
          setStream(stream);
          recorderRef.current = new MediaRecorder(stream);
          audioContextRef.current = new AudioContext({ sampleRate: WHISPER_SAMPLING_RATE });

          recorderRef.current.onstart = () => {
            setRecording(true);
            setChunks([]);
          }
          recorderRef.current.ondataavailable = (e) => {
            if (e.data.size > 0) {
              setChunks((prev) => [...prev, e.data]);
            } else {
              setTimeout(() => {
                recorderRef.current.requestData();
              }, 25);
            }
          };
          recorderRef.current.onstop = () => {
            setRecording(false);
          };
        })
        .catch(err => console.error("The following error occurred: ", err));
    } else {
      console.error("getUserMedia not supported on your browser!");
    }

    return () => {
      recorderRef.current?.stop();
      recorderRef.current = null;
    };
  }, []);

  // Transcription processing
  useEffect(() => {
    if (!recorderRef.current) return;
    if (!isTranscribing) return;
    if (!recording) return;
    if (isProcessing) return;
    if (status !== 'ready') return;

    if (chunks.length > 0) {
      const blob = new Blob(chunks, { type: recorderRef.current.mimeType });
      const fileReader = new FileReader();

      fileReader.onloadend = async () => {
        const arrayBuffer = fileReader.result;
        const decoded = await audioContextRef.current.decodeAudioData(arrayBuffer);
        let audio = decoded.getChannelData(0);
        if (audio.length > MAX_SAMPLES) {
          audio = audio.slice(-MAX_SAMPLES);
        }
        worker.current.postMessage({ type: 'generate', data: { audio, language } });
      }
      fileReader.readAsArrayBuffer(blob);
    } else {
      recorderRef.current?.requestData();
    }
  }, [status, recording, isProcessing, chunks, language, isTranscribing]);

  // Function to send text to FastAPI backend
  async function sendToGoogleApi(data) {
    if (!data) return;
    setIsApiLoading(true);
    setPendingExchange({ person: data.Person, speech: data.Speech }); // Store for later
    try {
      const url = 'https://c289a6d50b0d.ngrok-free.app/chat'; // FastAPI endpoint
      const payload = typeof data === 'object'
        ? {
            ...data,
            Speech: Array.isArray(data.Speech) ? data.Speech : [data.Speech]
          }
        : { message: data };
      console.log('Sending payload to FastAPI:', JSON.stringify(payload, null, 2));
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const dataRes = await response.json();
      console.log('FastAPI response:', dataRes);
      let reply = '';
      if (dataRes.error) {
        setApiResponse(`Error: ${dataRes.error}`);
        reply = `Error: ${dataRes.error}`;
      } else if (dataRes.response) {
        setApiResponse(dataRes.response);
        reply = dataRes.response;
        // Speak the reply aloud
        if (reply) {
          window.speechSynthesis.cancel(); // Stop any ongoing speech
          const synth = window.speechSynthesis;
          const voices = synth.getVoices();
          let femaleVoice = voices.find(v => v.name.toLowerCase().includes('female') && v.lang.startsWith('en'))
            || voices.find(v => v.gender === 'female' && v.lang.startsWith('en'))
            || voices.find(v => v.name.toLowerCase().includes('female'))
            || voices.find(v => v.gender === 'female')
            || voices.find(v => v.lang.startsWith('en'))
            || voices[0];
          const utterance = new window.SpeechSynthesisUtterance(reply);
          if (femaleVoice) utterance.voice = femaleVoice;
          synth.speak(utterance);
        }
      } else {
        setApiResponse('Error: No valid response from FastAPI');
        reply = 'Error: No valid response from FastAPI';
      }
      // Append to chat
      setChats(prevChats => {
        const updatedChats = [...prevChats];
        const currentChat = updatedChats[currentChatIndex] ? [...updatedChats[currentChatIndex]] : [];
        currentChat.push({
          person: data.Person,
          speech: data.Speech,
          geminiReply: reply
        });
        updatedChats[currentChatIndex] = currentChat;
        return updatedChats;
      });
      setPendingExchange(null);
    } catch (error) {
      setApiResponse('Error: ' + error.message);
      console.error('FastAPI fetch error:', error);
    } finally {
      setIsApiLoading(false);
    }
  }

  const toggleTranscription = () => {
    if (isTranscribing) {
      // Stop transcription
      recorderRef.current?.stop();
      setIsTranscribing(false);
      // Do NOT send to API here!
    } else {
      // Start transcription
      if (status === 'ready') {
        setApiResponse(null); // Clear previous API response
        recorderRef.current?.start();
        setIsTranscribing(true);
      }
    }
  };

  const handleFaceDetected = (data) => {
    setFaceData(data);
    if (data && data.faces && data.faces.length > 0) {
      // Find the first face with confidence > 0.6
      const confidentFace = data.faces.find(face => face.confidence > 0.6);
      setDetectedName(confidentFace ? confidentFace.name : "Visitor");
    } else {
      setDetectedName(null);
    }
  };

  return (
    IS_WEBGPU_AVAILABLE
      ? (<div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 text-white">
          <div className="container mx-auto px-4 py-8">
            {/* Header */}
            <div className="text-center mb-8">
              <h1 className="text-5xl font-bold mb-2 bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500">
                MIROB
              </h1>
              <p className="text-gray-400">Real-time Speech & Face Recognition</p>
            </div>

            {/* Main Content */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Face Detection Panel */}
              <div className="bg-gray-800 rounded-xl p-6 shadow-lg">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-2xl font-semibold">Face Detection</h2>
                  <div className="flex items-center">
                    <div className={`w-3 h-3 rounded-full mr-2 ${faceData ? 'bg-green-500' : 'bg-red-500'}`}></div>
                    <span className="text-sm">{faceData ? 'Connected' : 'Connecting...'}</span>
                  </div>
                </div>
                <div className="relative">
                  <FaceDetection onFaceDetected={handleFaceDetected} />
                  {faceData && faceData.faces && faceData.faces.length > 0 && (
                    <div className="mt-4 space-y-2">
                      {faceData.faces.map((face, index) => (
                        <div key={index} className="bg-gray-700 rounded-lg p-3">
                          <div className="flex justify-between items-center">
                            <span className="font-medium">{face.name}</span>
                            <span className="text-sm text-gray-400">
                              {Math.round(face.confidence * 100)}% confidence
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Show the dictionary (Person & Speech) below FaceDetection */}
                  {(detectedName || text) && (
                    <div className="mt-4 p-3 bg-gray-900 rounded-lg text-xs text-white">
                      <div className="font-semibold mb-1">Payload sent to LLM Pipeline:</div>
                      <pre className="whitespace-pre-wrap break-all">{JSON.stringify({ Person: detectedName || '', Speech: text || '' }, null, 2)}</pre>
                      <button
                        className="mt-2 px-3 py-1 bg-blue-600 rounded hover:bg-blue-700 text-xs font-semibold"
                        onClick={() => {
                          setChats(prev => [...prev, []]);
                          setCurrentChatIndex(chats.length);
                        }}
                      >
                        New Chat
                      </button>
                    </div>
                  )}
                  {/* Chat history display */}
                  {chats[currentChatIndex] && chats[currentChatIndex].length > 0 && (
                    <div className="mt-4 p-3 bg-gray-800 rounded-lg text-xs text-white">
                      <div className="font-semibold mb-1">Current Chat:</div>
                      <ul className="space-y-2">
                        {chats[currentChatIndex].map((msg, idx) => (
                          <li key={idx} className="border-b border-gray-700 pb-2">
                            <div><span className="font-semibold">Person:</span> {msg.person}</div>
                            <div><span className="font-semibold">Speech:</span> {msg.speech}</div>
                            <div><span className="font-semibold">Gemini:</span> {msg.geminiReply}</div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              {/* Speech Recognition Panel */}
              <div className="bg-gray-800 rounded-xl p-6 shadow-lg">
                <h2 className="text-2xl font-semibold mb-4">Speech Recognition</h2>
                {status === null && (
                  <div className="text-center py-8">
                    <p className="mb-4 text-gray-400">
                      Load the speech recognition model to start transcribing
                    </p>
                    <button
                      className="px-6 py-3 bg-gradient-to-r from-blue-500 to-purple-600 rounded-lg 
                               hover:from-blue-600 hover:to-purple-700 transition-all duration-200
                               disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={() => {
                        worker.current.postMessage({ type: 'load' });
                        setStatus('loading');
                      }}
                      disabled={status !== null}
                    >
                      Load Model
                    </button>
                  </div>
                )}
                
                {status === 'loading' && (
                  <div className="space-y-4">
                    <p className="text-center text-gray-400">{loadingMessage}</p>
                    {progressItems.map(({ file, progress, total }, i) => (
                      <Progress key={i} text={file} percentage={progress} total={total} />
                    ))}
                  </div>
                )}

                {status === 'ready' && (
                  <div className="space-y-4">
                    <AudioVisualizer className="w-full rounded-lg" stream={stream} />
                    <div className="relative bg-gray-700 rounded-lg p-4 min-h-[200px]">
                      {/* Editable transcription text */}
                      <textarea
                        className="w-full bg-transparent text-gray-200 resize-none outline-none border-none"
                        style={{ minHeight: '120px' }}
                        value={text}
                        onChange={e => setText(e.target.value)}
                        disabled={isTranscribing}
                      />
                      {tps && (
                        <span className="absolute bottom-2 right-2 text-sm text-gray-400">
                          {tps.toFixed(2)} tokens/s
                        </span>
                      )}
                    </div>
                    {isApiLoading && <p className="text-gray-400 mt-2">Processing LLM Pipeline request...</p>}
                    {apiResponse && (
                      <div className="mt-4 p-4 bg-gray-600 rounded-lg">
                        <h3 className="text-lg font-semibold mb-2">Response</h3>
                        <p>{apiResponse}</p>
                      </div>
                    )}
                    <div className="flex justify-between items-center">
                      <LanguageSelector 
                        language={language} 
                        setLanguage={(e) => {
                          if (isTranscribing) {
                            recorderRef.current?.stop();
                            setLanguage(e);
                            recorderRef.current?.start();
                          } else {
                            setLanguage(e);
                          }
                        }} 
                      />
                      <div className="flex gap-2">
                        <button 
                          className={`px-4 py-2 rounded-lg transition-colors ${
                            isTranscribing 
                              ? 'bg-red-600 hover:bg-red-700' 
                              : 'bg-green-600 hover:bg-green-700'
                          }`}
                          onClick={toggleTranscription}
                        >
                          {isTranscribing ? 'Stop' : 'Start'}
                        </button>
                        <button 
                          className="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600 transition-colors"
                          onClick={() => {
                            if (isTranscribing) {
                              recorderRef.current?.stop();
                            }
                            setText('');
                            setApiResponse(null);
                            if (isTranscribing) {
                              recorderRef.current?.start();
                            }
                          }}
                        >
                          Clear
                        </button>
                        {/* Remove Test Gemini, add Test LLM Pipeline */}
                        <button
                          className="px-4 py-2 bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
                          onClick={() => sendToGoogleApi({ Person: detectedName || '', Speech: text || '' })}
                        >
                          Test LLM Pipeline
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>)
      : (<div className="fixed w-screen h-screen bg-black z-10 bg-opacity-[92%] text-white text-2xl font-semibold flex justify-center items-center text-center">
          WebGPU is not supported<br />by this browser :(
        </div>)
  );
}

export default App;