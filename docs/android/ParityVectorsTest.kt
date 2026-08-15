package xyz.ctrlarcz.domain.crypto

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import xyz.ctrlarcz.domain.chain.Addresses
import xyz.ctrlarcz.domain.chain.ArcChain

/**
 * Holds this app's protocol code to the SDK's, using the vectors the SDK generates.
 *
 * The Android client does not consume @ctrl-arcz/sdk; it is a hand-written Kotlin port of
 * the same protocol, so nothing here fails to compile when the TypeScript side changes. It
 * fails on chain instead, at the user's expense: a transfer minted on one platform stops
 * being claimable on the other, or a stealth box created on the web is invisible on the
 * phone and the money looks lost. This file is the only thing standing between a change
 * over there and that outcome.
 *
 * The vectors are read from a checked-in copy of packages/sdk/parity-vectors.json and are
 * never regenerated here. A test that produces its own expected values from the code it is
 * testing agrees with itself forever; these values came from the other implementation.
 *
 * Refreshing it is a file copy:
 *   cp <monorepo>/packages/sdk/parity-vectors.json app/src/test/resources/
 */
class ParityVectorsTest {

    private val vectors: JSONObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("parity-vectors.json")
            ?: error("parity-vectors.json is missing from the test resources")
        JSONObject(stream.bufferedReader().readText())
    }

    private val chain get() = vectors.getJSONObject("chain")
    private val claim get() = vectors.getJSONObject("claim")
    private val stealth get() = vectors.getJSONObject("stealth")

    private fun JSONObject.arrayOf(name: String) =
        getJSONArray(name).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }

    // ------------------------------------------------------------------ chain

    @Test
    fun `chain constants match the sdk`() {
        assertEquals(chain.getLong("chainId"), ArcChain.CHAIN_ID)
        assertEquals(chain.getInt("usdcDecimals"), ArcChain.USDC_DECIMALS)
        assertEquals(chain.getLong("maxLogRange"), ArcChain.MAX_LOG_RANGE)
        val blocks = chain.getJSONObject("deployBlocks")
        assertEquals(blocks.getLong("ctrlArcZ"), ArcChain.CTRL_ARCZ_DEPLOY_BLOCK)
        assertEquals(blocks.getLong("stealthAnnouncer"), Addresses.STEALTH_ANNOUNCER_DEPLOY_BLOCK)
        // cctpDomain is in the file but has no counterpart here: this client does not build
        // CCTP messages, the relayer does. Left unasserted rather than quietly skipped.
    }

    /**
     * Addresses are compared as written, case included. The file records the canonical
     * checksummed render rather than whatever someone typed, and case is exactly where the
     * two implementations drifted the first time: the SDK emitted EIP-55 and this emitted
     * lowercase. Comparing these case-insensitively would put that blind spot back.
     */
    @Test
    fun `every contract address matches the sdk, checksum included`() {
        val a = chain.getJSONObject("addresses")
        assertEquals(a.getString("usdc"), Addresses.USDC)
        assertEquals(a.getString("eurc"), Addresses.EURC)
        assertEquals(a.getString("memo"), Addresses.MEMO)
        assertEquals(a.getString("permit2"), Addresses.PERMIT2)
        assertEquals(a.getString("multicall3"), Addresses.MULTICALL3)
        assertEquals(a.getString("multicall3From"), Addresses.MULTICALL3_FROM)
        assertEquals(a.getString("ctrlArcZ"), Addresses.CTRL_ARCZ)
        assertEquals(a.getString("codeClaimVerifier"), Addresses.CODE_CLAIM_VERIFIER)
        assertEquals(a.getString("spendPolicyFactory"), Addresses.SPEND_POLICY_FACTORY)
        assertEquals(a.getString("spendPolicyAccountImpl"), Addresses.SPEND_POLICY_ACCOUNT_IMPL)
        assertEquals(a.getString("shieldVault"), Addresses.SHIELD_VAULT)
        assertEquals(a.getString("stealthAnnouncer"), Addresses.STEALTH_ANNOUNCER)
    }

    // ------------------------------------------------------------------ claim codes

    @Test
    fun `a secret carries the same entropy on both sides`() {
        val bits = ClaimCodes.SECRET_CHARS * ClaimCodes.ALPHABET_BITS
        assertEquals(claim.getInt("secretBits"), bits)
    }

    @Test
    fun `deriving from a secret matches the sdk`() {
        for (v in claim.arrayOf("derived")) {
            val secret = ClaimCodes.fromSecret(v.getString("input"))
                ?: error("the sdk accepts ${v.getString("input")} and this does not")
            assertEquals(v.getString("code"), secret.code)
            assertEquals(v.getString("salt"), secret.salt)
            assertEquals(v.getString("claimHash"), secret.claimHash)
            assertEquals(v.getString("secret"), ClaimCodes.format(secret.code))
        }
    }

    @Test
    fun `normalising an entered code matches the sdk, including the ambiguous letters`() {
        for (v in claim.arrayOf("normalisation")) {
            assertEquals(v.getString("normalised"), ClaimCodes.normalise(v.getString("input")))
        }
    }

    @Test
    fun `what the sdk rejects is rejected here too`() {
        for (v in claim.arrayOf("rejected")) {
            assertNull(
                "accepted ${v.getString("input")}, which the sdk rejects",
                ClaimCodes.normalise(v.getString("input")),
            )
        }
    }

    @Test
    fun `grouping matches the sdk`() {
        for (v in claim.arrayOf("formatting")) {
            assertEquals(v.getString("formatted"), ClaimCodes.format(v.getString("input")))
        }
    }

    @Test
    fun `salts and commitments match the sdk`() {
        for (v in claim.arrayOf("salts")) {
            assertEquals(v.getString("salt"), ClaimCodes.saltFromSecret(v.getString("secret")))
        }
        for (v in claim.arrayOf("commitments")) {
            val secret = ClaimCodes.fromSecret(v.getString("secret"))!!
            assertEquals(v.getString("salt"), secret.salt)
            assertEquals(v.getString("claimHash"), secret.claimHash)
        }
    }

    // ---------------------------------------------------------------------- stealth

    @Test
    fun `the scheme id and the signing message are byte identical`() {
        assertEquals(stealth.getInt("schemeId"), Stealth.SCHEME_ID)
        // A single character apart and the wallet derives different keys from the same
        // signature, which loses every box the other platform created.
        assertEquals(stealth.getString("keyMessage"), Stealth.KEY_MESSAGE)
    }

    @Test
    fun `keys derived from a signature match the sdk`() {
        for (v in stealth.arrayOf("keys")) {
            val keys = Stealth.deriveKeys(v.getString("signature"))
            assertEquals(v.getString("spendingKey"), keys.spendingKey)
            assertEquals(v.getString("viewingKey"), keys.viewingKey)
            assertEquals(v.getString("spendingPub"), keys.spendingPub)
            assertEquals(v.getString("viewingPub"), keys.viewingPub)
        }
    }

    @Test
    fun `a stealth address generated here is the one the sdk generates`() {
        for (v in stealth.arrayOf("addresses")) {
            val keys = Stealth.deriveKeys(v.getString("signature"))
            val announcement = Stealth.generateStealthAddress(
                spendingPub = keys.spendingPub,
                viewingPub = keys.viewingPub,
                ephemeralKeyHex = v.getString("ephemeralKey"),
            )
            assertEquals(v.getString("stealthAddress"), announcement.stealthAddress)
            assertEquals(v.getString("ephemeralPubKey"), announcement.ephemeralPubKey)
            assertEquals(v.getInt("viewTag"), announcement.viewTag)
        }
    }

    @Test
    fun `a box announced by the sdk is recognised and spendable here`() {
        for (v in stealth.arrayOf("addresses")) {
            val keys = Stealth.deriveKeys(v.getString("signature"))
            // The receiving half: scanning an announcement and recognising it as ours.
            assertEquals(
                v.getString("recovered"),
                Stealth.checkStealthAddress(
                    viewingKey = keys.viewingKey,
                    spendingPub = keys.spendingPub,
                    ephemeralPubKey = v.getString("ephemeralPubKey"),
                    viewTag = v.getInt("viewTag"),
                ),
            )
            // And the half that actually moves the money.
            assertEquals(
                v.getString("stealthPrivateKey"),
                Stealth.computeStealthPrivateKey(
                    spendingKey = keys.spendingKey,
                    viewingKey = keys.viewingKey,
                    ephemeralPubKey = v.getString("ephemeralPubKey"),
                ),
            )
        }
    }

    @Test
    fun `a mismatched view tag is skipped, the same way the sdk skips it`() {
        val mismatch = stealth.getJSONObject("viewTagMismatch")
        val first = stealth.arrayOf("addresses").first { it.getInt("viewTag") == mismatch.getInt("viewTag") }
        val keys = Stealth.deriveKeys(first.getString("signature"))
        assertNull(
            Stealth.checkStealthAddress(
                viewingKey = keys.viewingKey,
                spendingPub = keys.spendingPub,
                ephemeralPubKey = first.getString("ephemeralPubKey"),
                viewTag = mismatch.getInt("wrongTag"),
            ),
        )
    }
}
