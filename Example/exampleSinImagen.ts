//import { MessageType, MessageOptions, Mimetype } from "@whiskeysockets/baileys";
import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, BinaryInfo, delay, DisconnectReason, encodeWAM, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, makeCacheableSignalKeyStore, makeInMemoryStore, PHONENUMBER_MCC, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
import MAIN_LOGGER from '../src/Utils/logger'
import open from 'open'
import fs from 'fs'
import mysql from 'mysql'
import { setTimeout } from 'timers'


const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'personas',
	charset: 'utf8mb4',
	supportBigNumbers: true,
    bigNumberStrings: true
};

// Crear una conexión a la base de datos MySQL
const connection = mysql.createConnection(dbConfig);

// Conectar a la base de datos
connection.connect((error) => {
    if (error) {
        console.error('Error al conectar a la base de datos MySQL:', error);
        return;
    }
    console.log('Conexión establecida correctamente a la base de datos MySQL');

    // Ejecutar la consulta SQL para obtener usuarios activados
    const sqlUsuarios = 'SELECT nombre, telefono FROM usuarios WHERE activado = 1';
    const sqlMensajes = 'SELECT v1, v2, v3, v4, v5, img FROM mensajes LIMIT 1';

    connection.query(sqlUsuarios, (errorUsuarios, resultsUsuarios, fieldsUsuarios) => {
        if (errorUsuarios) {
            console.error('Error al ejecutar la consulta de usuarios:', errorUsuarios);
            return;
        }
        console.log("Conectado a usuarios");

		let usuarios = resultsUsuarios

        connection.query(sqlMensajes, (errorMensajes, resultsMensajes, fieldsMensajes) => {
            if (errorMensajes) {
                console.error('Error al ejecutar la consulta de mensajes:', errorMensajes);
                return;
            }

            // Filtrar los mensajes no nulos
            let mensajes = [];
            let img = resultsMensajes[resultsMensajes.length];
			resultsMensajes[resultsMensajes.length] = null;
            if (resultsMensajes.length > 0) {
                const row = resultsMensajes[0];
                mensajes = [row.v1, row.v2, row.v3, row.v4, row.v5].filter((msg: any) => msg !== null) as never[];
            }

            if (mensajes.length === 0) {
                mensajes = ['Mensaje predeterminado'] as never[];
            }

            console.log(mensajes);
			
			const logger = MAIN_LOGGER.child({})
			logger.level = 'trace'

			const useStore = !process.argv.includes('--no-store')
			const doReplies = !process.argv.includes('--no-reply')
			const usePairingCode = process.argv.includes('--use-pairing-code')
			const useMobile = process.argv.includes('--mobile')

			// external map to store retry counts of messages when decryption/encryption fails
			// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
			const msgRetryCounterCache = new NodeCache()

			// Read line interface
			const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
			const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

			// the store maintains the data of the WA connection in memory
			// can be written out to a file & read from it
			const store = useStore ? makeInMemoryStore({ logger }) : undefined
			store?.readFromFile('./baileys_store_multi.json')
			// save every 10s
			setInterval(() => {
				store?.writeToFile('./baileys_store_multi.json')
			}, 10_000)

			// start a connection
			const startSock = async() => {
				const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
				// fetch latest version of WA Web
				const { version, isLatest } = await fetchLatestBaileysVersion()
				console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

				const sock = makeWASocket({
					version,
					logger,
					printQRInTerminal: !usePairingCode,
					mobile: useMobile,
					auth: {
						creds: state.creds,
						/** caching makes the store faster to send/recv messages */
						keys: makeCacheableSignalKeyStore(state.keys, logger),
					},
					msgRetryCounterCache,
					generateHighQualityLinkPreview: true,
					// ignore all broadcast messages -- to receive the same
					// comment the line below out
					// shouldIgnoreJid: jid => isJidBroadcast(jid),
					// implement to handle retries & poll updates
					getMessage,
				})

				store?.bind(sock.ev)

				// Pairing code for Web clients
				if(usePairingCode && !sock.authState.creds.registered) {
					if(useMobile) {
						throw new Error('Cannot use pairing code with mobile api')
					}

					const phoneNumber = await question('Please enter your mobile phone number:\n')
					const code = await sock.requestPairingCode(phoneNumber)
					console.log(`Pairing code: ${code}`)
				}

				// If mobile was chosen, ask for the code
				if(useMobile && !sock.authState.creds.registered) {
					const { registration } = sock.authState.creds || { registration: {} }

					if(!registration.phoneNumber) {
						registration.phoneNumber = await question('Please enter your mobile phone number:\n')
					}

					const libPhonenumber = await import("libphonenumber-js")
					const phoneNumber = libPhonenumber.parsePhoneNumber(registration!.phoneNumber)
					if(!phoneNumber?.isValid()) {
						throw new Error('Invalid phone number: ' + registration!.phoneNumber)
					}

					registration.phoneNumber = phoneNumber.format('E.164')
					registration.phoneNumberCountryCode = phoneNumber.countryCallingCode
					registration.phoneNumberNationalNumber = phoneNumber.nationalNumber
					const mcc = PHONENUMBER_MCC[phoneNumber.countryCallingCode]
					if(!mcc) {
						throw new Error('Could not find MCC for phone number: ' + registration!.phoneNumber + '\nPlease specify the MCC manually.')
					}

					registration.phoneNumberMobileCountryCode = mcc

					async function enterCode() {
						try {
							const code = await question('Please enter the one time code:\n')
							const response = await sock.register(code.replace(/["']/g, '').trim().toLowerCase())
							console.log('Successfully registered your phone number.')
							//console.log(response)
							rl.close()
						} catch(error) {
							console.error('Failed to register your phone number. Please try again.\n', error)
							await askForOTP()
						}
					}

					async function enterCaptcha() {
						const response = await sock.requestRegistrationCode({ ...registration, method: 'captcha' })
						const path = __dirname + '/captcha.png'
						fs.writeFileSync(path, Buffer.from(response.image_blob!, 'base64'))

						open(path)
						const code = await question('Please enter the captcha code:\n')
						fs.unlinkSync(path)
						registration.captcha = code.replace(/["']/g, '').trim().toLowerCase()
					}

					async function askForOTP() {
						if (!registration.method) {
							await delay(2000)
							let code = await question('How would you like to receive the one time code for registration? "sms" or "voice"\n')
							code = code.replace(/["']/g, '').trim().toLowerCase()
							if(code !== 'sms' && code !== 'voice') {
								return await askForOTP()
							}

							registration.method = code
						}

						try {
							await sock.requestRegistrationCode(registration)
							await enterCode()
						} catch(error) {
							console.error('Failed to request registration code. Please try again.\n', error)

							if(error?.reason === 'code_checkpoint') {
								await enterCaptcha()
							}

							await askForOTP()
						}
					}

					askForOTP()
				}

				const sendMessageWTyping = async(msg: AnyMessageContent, jid: string) => {
					await sock.presenceSubscribe(jid)
					await delay(500)

					await sock.sendPresenceUpdate('composing', jid)
					await delay(2000)

					await sock.sendPresenceUpdate('paused', jid)

					await sock.sendMessage(jid, msg)
				}

				// Define the function to send a message to a specific number
				const sendMessageToNumber = async(number: string, message: string) => {
					const jid = number + '@s.whatsapp.net'
					await sendMessageWTyping({ text: message }, jid)
					console.log(`Message sent to ${number}`)
				}

				// the process function lets you process all events that just occurred
				// efficiently in a batch
				sock.ev.process(
					// events is a map for event name => event data
					async(events) => {
						// something about the connection changed
						// maybe it closed, or we received all offline message or connection opened
						if(events['connection.update']) {
							const update = events['connection.update']
							const { connection, lastDisconnect } = update
							if(connection === 'close') {
								// reconnect if not logged out
								if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
									startSock()
								} else {
									console.log('Connection closed. You are logged out.')
								}
							} else if(connection === 'open') {
								// Connection is open, send the message
								//const numeros = ['5492216759472','5492213140317']								
								if (img !== null) {
									for (const contacto of resultsUsuarios) {
										let mensaje = mensajes[Math.floor(Math.random() * mensajes.length)];
										// Enviar mensaje al número actual
										let jid = contacto.telefono + '@s.whatsapp.net'
										// Aca quiero mandar un mensaje con la imagen y el mensaje
										console.log("Mensaje mandado a "+ contacto.nombre)
									}
								}else {
									for (const contacto of resultsUsuarios) {
										let mensaje = mensajes[Math.floor(Math.random() * mensajes.length)];
										// Enviar mensaje al número actual
										let jid = contacto.telefono + '@s.whatsapp.net'
										await sendMessageWTyping({ text: mensaje}, jid)
										console.log("Mensaje mandado a "+ contacto.nombre)
										//await sendMessageToNumber(contacto, 'Hola, esto es una prueba')
									}
								}
								setTimeout(() => {
									console.log("se mandaron todos los mensajes")
									process.exit()
								},5000)
							}

							//console.log('connection update', update)
						}
						
						// credentials updated -- save them
						if(events['creds.update']) {
							await saveCreds()
						}
						/*
						// received a new message
						if(events['messages.upsert']) {
							const upsert = events['messages.upsert']
							//console.log('recv messages ', JSON.stringify(upsert, undefined, 2))
							
							if(upsert.type === 'notify') {
								for(const msg of upsert.messages) {
									if(!msg.key.fromMe && doReplies) {
										//console.log('replying to', msg.key.remoteJid)
										await sock!.readMessages([msg.key])
										await sendMessageWTyping({ text: 'Hello there!' }, msg.key.remoteJid!)
									}
								}
							}
						}
						*/
					}
				)

				return sock

				async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
					if(store) {
						const msg = await store.loadMessage(key.remoteJid!, key.id!)
						return msg?.message || undefined
					}

					// only if store is present
					return proto.Message.fromObject({})
				}
			}

			startSock()

        });
    });
});

/*
Abrir PowerShell como Administrador:

Busca "PowerShell" en el menú de inicio, haz clic derecho y selecciona "Ejecutar como administrador".

Verificar la política de ejecución actual:

Ejecuta el siguiente comando para ver la política de ejecución actual:

powershell
Copy code
Get-ExecutionPolicy
Esto generalmente devolverá "Restricted", lo que significa que los scripts no están permitidos.

Cambiar la política de ejecución:

Cambia la política de ejecución a "RemoteSigned" o "Unrestricted" temporalmente para permitir la ejecución de scripts. Para hacer esto, ejecuta el siguiente comando:

powershell
Copy code
Set-ExecutionPolicy RemoteSigned
Si prefieres permitir todos los scripts, puedes usar:

powershell
Copy code
Set-ExecutionPolicy Unrestricted
Confirma el cambio si se te pide confirmación.

Ejecutar el comando yarn:

Ahora puedes intentar ejecutar yarn nuevamente:

powershell
Copy code
yarn
Restaurar la política de ejecución (opcional):

Por seguridad, puedes restaurar la política de ejecución original después de haber ejecutado tu comando. Para restaurar a "Restricted":

powershell
Copy code
Set-ExecutionPolicy Restricted
Nota importante: Cambiar la política de ejecución puede tener implicaciones de seguridad. Asegúrate de entender las implicaciones y de cambiar la política solo cuando sea necesario.

Después de realizar estos pasos, deberías poder ejecutar yarn sin problemas. Si tienes alguna otra pregunta o problema, no dudes en decírmelo.
*/