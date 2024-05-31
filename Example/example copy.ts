import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, delay, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, makeInMemoryStore, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '@whiskeysockets/baileys'
import MAIN_LOGGER from '@whiskeysockets/baileys/lib/Utils/logger'
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
            let img = resultsMensajes[0].img;
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

            const msgRetryCounterCache = new NodeCache()

            const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
            const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

            const store = useStore ? makeInMemoryStore({ logger }) : undefined
            store?.readFromFile('./baileys_store_multi.json')
            setInterval(() => {
                store?.writeToFile('./baileys_store_multi.json')
            }, 10_000)

            const startSock = async () => {
                const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
                const { version, isLatest } = await fetchLatestBaileysVersion()
                console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

                const sock = makeWASocket({
                    version,
                    logger,
                    printQRInTerminal: !usePairingCode,
                    mobile: useMobile,
                    auth: {
                        creds: state.creds,
                        keys: makeCacheableSignalKeyStore(state.keys, logger),
                    },
                    msgRetryCounterCache,
                    generateHighQualityLinkPreview: true,
                    getMessage,
                })

                store?.bind(sock.ev)

                if (usePairingCode && !sock.authState.creds.registered) {
                    if (useMobile) {
                        throw new Error('Cannot use pairing code with mobile api')
                    }

                    const phoneNumber = await question('Please enter your mobile phone number:\n')
                    const code = await sock.requestPairingCode(phoneNumber)
                    console.log(`Pairing code: ${code}`)
                }

                if (useMobile && !sock.authState.creds.registered) {
                    const { registration } = sock.authState.creds || { registration: {} }

                    if (!registration.phoneNumber) {
                        registration.phoneNumber = await question('Please enter your mobile phone number:\n')
                    }

                    const libPhonenumber = await import("libphonenumber-js")
                    const phoneNumber = libPhonenumber.parsePhoneNumber(registration!.phoneNumber)
                    if (!phoneNumber?.isValid()) {
                        throw new Error('Invalid phone number: ' + registration!.phoneNumber)
                    }

                    registration.phoneNumber = phoneNumber.format('E.164')
                    registration.phoneNumberCountryCode = phoneNumber.countryCallingCode
                    registration.phoneNumberNationalNumber = phoneNumber.nationalNumber
                    const mcc = PHONENUMBER_MCC[phoneNumber.countryCallingCode]
                    if (!mcc) {
                        throw new Error('Could not find MCC for phone number: ' + registration!.phoneNumber + '\nPlease specify the MCC manually.')
                    }

                    registration.phoneNumberMobileCountryCode = mcc

                    async function enterCode() {
                        try {
                            const code = await question('Please enter the one time code:\n')
                            const response = await sock.register(code.replace(/["']/g, '').trim().toLowerCase())
                            console.log('Successfully registered your phone number.')
                        } catch (error) {
                            console.error('Failed to register your phone number. Please try again.\n', error)
                            await askForOTP()
                        }
                    }

                    async function enterCaptcha() {
                        const response = await sock.requestRegistrationCode({ ...registration, method: 'captcha' })
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
                            if (code !== 'sms' && code !== 'voice') {
                                return await askForOTP()
                            }

                            registration.method = code
                        }

                        try {
                            await sock.requestRegistrationCode(registration)
                            await enterCode()
                        } catch (error) {
                            console.error('Failed to request registration code. Please try again.\n', error)

                            if (error?.reason === 'code_checkpoint') {
                                await enterCaptcha()
                            }

                            await askForOTP()
                        }
                    }

                    askForOTP()
                }

                const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
                    await sock.presenceSubscribe(jid)
                    await delay(500)

                    await sock.sendPresenceUpdate('composing', jid)
                    await delay(2000)

                    await sock.sendPresenceUpdate('paused', jid)

                    await sock.sendMessage(jid, msg)
                }

                // Define the function to send a message to a specific number
                const sendMessageToNumber = async (number: string, message: AnyMessageContent) => {
                    const jid = number + '@s.whatsapp.net'
                    await sendMessageWTyping(message, jid)
                    console.log(`Message sent to ${number}`)
                }

                sock.ev.process(
                    async (events) => {
                        if (events['connection.update']) {
                            const update = events['connection.update']
                            const { connection, lastDisconnect } = update
                            if (connection === 'close') {
                                if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
                                    startSock()
                                } else {
                                    console.log('Connection closed. You are logged out.')
                                }
                            } else if (connection === 'open') {
                                if (img !== null) {
                                    for (const contacto of resultsUsuarios) {
                                        let mensaje = mensajes[Math.floor(Math.random() * mensajes.length)];
                                        let jid = contacto.telefono + '@s.whatsapp.net'
                                        const message = {
                                            image: { url: img },
                                            caption: mensaje,
                                        }
										await sendMessageWTyping(message, jid)
                                        console.log("Mensaje mandado a " + contacto.nombre)
                                    }
                                } else {
                                    for (const contacto of resultsUsuarios) {
                                        let mensaje = mensajes[Math.floor(Math.random() * mensajes.length)];
                                        let jid = contacto.telefono + '@s.whatsapp.net'
                                        await sendMessageWTyping({ text: mensaje }, jid)
                                        console.log("Mensaje mandado a " + contacto.nombre)
                                    }
                                }
                                setTimeout(() => {
                                    console.log("se mandaron todos los mensajes")
                                    process.exit()
                                }, 5000)
                            }
                        }

                        if (events['creds.update']) {
                            await saveCreds()
                        }
                    }
                )

                return sock

                async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
                    if (store) {
                        const msg = await store.loadMessage(key.remoteJid!, key.id!)
                        return msg?.message || undefined
                    }
                    return proto.Message.fromObject({})
                }
            }

            startSock()

        });
    });
});
